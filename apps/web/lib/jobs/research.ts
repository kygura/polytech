import { AnthropicOutageError, PodCancelledError, PodFailedError, PodTimeoutError, costUsd, disabledRunner, modelFor, runPod, type AgentResult, type PodStage } from "@pm/agents";
import { canStartPod, crowd, shouldReResearch, sizeTrade, type ResearchProfile, type Steering } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { outageDowngrade } from "./autonomy";
import { categoryConfidence } from "./calib";
import { DAY, addSpend, feeOf, toMarket, today, withLock, type Deps, type Skipped } from "./deps";
import { publish } from "./events";
import { matchMarkets, listProfiles, type Match } from "./profiles";
import { latestSnaps, shortlist } from "./screen";

export type Trigger = "initial" | "price-move" | "catalyst" | "stale" | "manual" | "profile";
/** `steering` = the resolved steering to run with (persisted on the pod); omitted = old behavior. */
export type ResearchOpts = { steering?: Steering; profileId?: string; cancelPollMs?: number };
export type ResearchResult = Skipped | { podId: string; status: "done" | "failed" | "cancelled"; thesisId?: string; reason?: string };

/** How often a running pod re-reads its row for `cancelRequestedAt`. */
export const CANCEL_POLL_MS = 2_000;
const MAX_TOOL_CALLS = 200;

/** Asks a running pod to stop; the pod's own poller notices within CANCEL_POLL_MS. */
export async function requestCancel(d: Pick<Deps, "db" | "now">, podId: string): Promise<"ok" | "not_found" | "not_running"> {
  const hit = await d.db.update(s.pods).set({ cancelRequestedAt: new Date(d.now()) }).where(and(eq(s.pods.id, podId), eq(s.pods.status, "running"))).returning({ id: s.pods.id });
  if (hit.length) return "ok";
  return (await d.db.select({ id: s.pods.id }).from(s.pods).where(eq(s.pods.id, podId))).length ? "not_running" : "not_found";
}

const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;
const catalystMs = (cs: string[]) => cs.map((c) => Date.parse(c.slice(0, 10))).filter(Number.isFinite);

type RunPatch = Partial<typeof s.agentRuns.$inferInsert> & { status: string };
const patchOf = (a: AgentResult): RunPatch =>
  a.ok
    ? { status: "ok", outputJson: a.run.output, usage: a.run.usage, durationS: a.run.durationS, toolCalls: (a.run.toolCalls ?? []).slice(0, MAX_TOOL_CALLS) }
    : { status: a.skipped ? "skipped" : a.cancelled ? "cancelled" : "failed", outputJson: { error: a.error } };

/** Ends the agent's `running` row; inserts one when the agent never started (skipped). */
async function endRun(d: Pick<Deps, "db" | "now">, podId: string, role: string, model: string, p: RunPatch) {
  const at = new Date(d.now());
  const hit = await d.db.update(s.agentRuns).set({ ...p, finishedAt: at }).where(and(eq(s.agentRuns.podId, podId), eq(s.agentRuns.role, role), eq(s.agentRuns.status, "running"))).returning({ id: s.agentRuns.id });
  if (!hit.length) await d.db.insert(s.agentRuns).values({ podId, role, model, startedAt: at, finishedAt: at, ...p });
}
/** Lifecycle writes are best effort: a failed progress write must not fail the pod. */
const soft = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { console.error("pod progress write failed:", e instanceof Error ? e.message : e); } };

// The host function dies at maxDuration (300 s in the research route and the workflow step route). A pod must fail cleanly inside it:
// agents 170 s + judge 90 s leaves ~40 s for setup and persisting. Raise all three together with maxDuration (Pro allows 800 s).
export const POD_WINDOW_MS = 300_000, POD_AGENTS_MS = 170_000, POD_JUDGE_MS = 90_000;
const FAILED_SKIP_MS = 24 * 3_600_000; // poison-market guard: no pick (initial, re-research, profile) this soon after a failed pod
const WAVE_MARGIN_MS = 20_000;
/** Markets with a pod that failed within FAILED_SKIP_MS. */
const failedRecently = async (db: Deps["db"], now: number) =>
  new Set((await db.select({ c: s.pods.conditionId }).from(s.pods).where(and(eq(s.pods.status, "failed"), gte(s.pods.startedAt, new Date(now - FAILED_SKIP_MS))))).map((r) => r.c));
// ponytail: a timed-out agent/judge reports no usage, so charge a flat guess per model (150k in/10k out agent, 20k in/2k out judge) so the daily cap cannot undercount; read real usage if the runner ever reports partials.
const timeoutUsd = (model: string, judge = false) => (judge ? costUsd(model, 20_000, 2_000) : costUsd(model, 150_000, 10_000));

/** Budget check -> pod -> judge -> sizing against the latest stored book -> `theses` row. */
export async function researchMarket(d: Deps, conditionId: string, trigger: Trigger = "manual", opts: ResearchOpts = {}): Promise<ResearchResult> {
  return withLock(d, `research:${conditionId}`, 30 * 60_000, async (): Promise<ResearchResult> => {
    if (d.runner === disabledRunner) return { skipped: true, reason: "RESEARCH_DISABLED" }; // prod without ANTHROPIC_API_KEY: no fake results
    const { settings: st, db } = d, now = d.now();
    const steering = opts.steering, judgeModel = modelFor("judge", { ...st.models, ...steering?.models });
    const mrow = (await db.select().from(s.markets).where(eq(s.markets.conditionId, conditionId)))[0];
    const snap = (await latestSnaps(db, [conditionId])).get(conditionId);
    if (!mrow || !snap?.book || snap.mid == null) return { skipped: true, reason: "NO_BOOK" };

    const conc = Math.max(1, Math.min(5, st.budget.maxConcurrentSandboxes));
    const dayStart = new Date(`${today(now)}T00:00:00Z`);
    const podId = id("pod");
    // check + insert under one lock so a parallel wave cannot overshoot maxPodsPerDay
    let rel: (() => Promise<void>) | null = null;
    for (let i = 0; i < 100 && !(rel = await d.kv.lock("research-budget", 30_000)); i++) await new Promise((r) => setTimeout(r, 50));
    if (!rel) return { skipped: true, reason: "LOCKED" };
    try {
      // reap pods stuck `running` (host killed mid-run): nothing outlives the function window, so past it they are dead
      await db.update(s.pods).set({ status: "failed" })
        .where(and(eq(s.pods.status, "running"), lt(s.pods.startedAt, new Date(now - POD_WINDOW_MS - 60_000))));
      const [{ n: podsToday }] = await db.select({ n: count() }).from(s.pods).where(gte(s.pods.startedAt, dayStart)) as [{ n: number }];
      const [{ n: running }] = await db.select({ n: count() }).from(s.pods).where(eq(s.pods.status, "running")) as [{ n: number }];
      const sp = (await db.select().from(s.spend).where(eq(s.spend.day, today(now))))[0];
      const ok = canStartPod(
        { podsToday, activeSandboxes: running * conc, spendTodayUsd: sp?.anthropicUsd ?? 0 },
        { maxPodsPerDay: st.budget.maxPodsPerDay, maxConcurrentSandboxes: st.budget.maxConcurrentSandboxes, dailySpendCapUsd: st.budget.dailySpendCapUsd },
        conc,
      );
      if (!ok.ok) return { skipped: true, reason: ok.reason! };
      await db.insert(s.pods).values({ id: podId, conditionId, startedAt: new Date(now), status: "running", trigger, profileId: opts.profileId ?? null, steering: steering ?? null, stage: "rules" });
    } finally {
      await rel();
    }
    publish("pod.started", { podId, conditionId, trigger });

    try {
      const market = toMarket(mrow);
      const sibRows = mrow.eventId ? await db.select().from(s.markets).where(eq(s.markets.eventId, mrow.eventId)) : [];
      const book = { bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid };
      const setStage = (stage: PodStage) => soft(async () => {
        await db.update(s.pods).set({ stage }).where(eq(s.pods.id, podId));
        publish("pod.stage", { podId, conditionId, stage });
      });
      // cancel: POST /api/pods/:id/cancel sets cancelRequestedAt (maybe on another instance); the pod notices on its next poll
      const ac = new AbortController();
      const poll = setInterval(() => void soft(async () => {
        if (ac.signal.aborted) return;
        const [p] = await db.select({ c: s.pods.cancelRequestedAt }).from(s.pods).where(eq(s.pods.id, podId));
        if (p?.c) ac.abort();
      }), opts.cancelPollMs ?? CANCEL_POLL_MS);
      let pod;
      try {
        pod = await runPod({
          market, siblings: sibRows.filter((r) => r.conditionId !== conditionId).slice(0, 10).map(toMarket), book, runner: d.runner, judge: d.judge,
          steering, settings: { models: st.models, concurrency: conc, timeoutMs: st.budget.sandboxTimeoutMin * 60_000, agentsMs: POD_AGENTS_MS, judgeMs: POD_JUDGE_MS, exaCallCap: st.budget.exaCallsPerPod, core: st },
          onAgentDone: (a) => publish("pod.agent", { podId, role: a.role, ok: a.ok }),
          signal: ac.signal,
          hooks: {
            onStage: (stage) => setStage(stage).then(() => stage === "judge" ? soft(() => db.insert(s.agentRuns).values({ podId, role: "judge", model: judgeModel, status: "running", startedAt: new Date(d.now()) })) : undefined),
            onAgentStart: (role, model) => soft(() => db.insert(s.agentRuns).values({ podId, role, model, status: "running", startedAt: new Date(d.now()) })),
            onAgentFinish: (role, a) => soft(() => endRun(d, podId, role, a.model, patchOf(a))),
          },
        });
      } catch (e) {
        if (e instanceof PodCancelledError) {
          const ok = e.agents.flatMap((a) => (a.ok ? [a] : []));
          await addSpend(db, now, ok.reduce((t, a) => t + a.run.usage.costUsd, 0), ok.reduce((t, a) => t + a.run.sandboxS, 0));
          await db.update(s.agentRuns).set({ status: "cancelled", finishedAt: new Date(d.now()) }).where(and(eq(s.agentRuns.podId, podId), eq(s.agentRuns.status, "running")));
          await db.update(s.pods).set({ status: "cancelled" }).where(eq(s.pods.id, podId));
          publish("pod.cancelled", { podId, conditionId });
          return { podId, status: "cancelled" };
        }
        const outage = e instanceof AnthropicOutageError || (e instanceof PodFailedError && (e.cause instanceof AnthropicOutageError || e.agents.some((a) => !a.ok && a.outage)));
        if (e instanceof PodFailedError) {
          // keep what the agents already cost / produced (their rows were written as they finished)
          const ok = e.agents.flatMap((a) => (a.ok ? [a] : []));
          const lost = e.agents.filter((a) => !a.ok && !a.skipped && a.error.startsWith("TIMEOUT")); // started, then cut off
          const judgeLost = e.cause instanceof PodTimeoutError && e.cause.what === "judge";
          await addSpend(db, now,
            ok.reduce((t, a) => t + a.run.usage.costUsd, 0) + lost.reduce((t, a) => t + timeoutUsd(a.model), 0) + (judgeLost ? timeoutUsd(judgeModel, true) : 0),
            ok.reduce((t, a) => t + a.run.sandboxS, 0) + lost.length * (POD_AGENTS_MS / 1000));
        }
        await db.update(s.agentRuns).set({ status: "failed", finishedAt: new Date(d.now()) }).where(and(eq(s.agentRuns.podId, podId), eq(s.agentRuns.status, "running"))); // the judge row
        await db.update(s.pods).set({ status: "failed" }).where(eq(s.pods.id, podId));
        const lowered = outage ? await outageDowngrade(d) : null;
        const timedOut = e instanceof PodFailedError && (e.cause instanceof PodTimeoutError || e.agents.some((a) => !a.ok && a.error.startsWith("TIMEOUT")));
        const reason = outage ? "ANTHROPIC_OUTAGE" : timedOut ? "TIMEOUT" : "POD_FAILED";
        publish("pod.failed", { podId, conditionId, reason, error: scrub(String(e instanceof Error ? e.message : e)), downgradedTo: lowered });
        return { podId, status: "failed", reason };
      } finally {
        clearInterval(poll);
      }
      await setStage("sizing");

      const j = pod.judge;
      const c = Math.min(j.confidence, await categoryConfidence(db, mrow.category)); // c <= 0.4 until 30 resolved in the category
      const cr = crowd({ top10Share: snap.top10Share ?? 0, netFlow: snap.book.netFlow, skew: 0 });
      const core = sizeTrade({
        bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid, pHat: j.p_hat, c, daysLeft: (market.endDate - now) / DAY,
        feeRate: feeOf(market), crowdC: cr.c, crowdSide: cr.side, settings: st,
      });

      // persist run, evidence, spend
      const ok5 = pod.agents.flatMap((a) => (a.ok ? [a.run.usage] : []));
      const sum = (f: "inputTokens" | "outputTokens" | "costUsd") => ok5.reduce((t, u) => t + u[f], 0);
      const jr = (await db.select({ at: s.agentRuns.startedAt }).from(s.agentRuns).where(and(eq(s.agentRuns.podId, podId), eq(s.agentRuns.role, "judge"))))[0];
      await endRun(d, podId, "judge", judgeModel, {
        status: "ok", outputJson: j, durationS: jr?.at ? (d.now() - jr.at.getTime()) / 1000 : null,
        usage: { inputTokens: pod.costs.inputTokens - sum("inputTokens"), outputTokens: pod.costs.outputTokens - sum("outputTokens"), costUsd: pod.costs.costUsd - sum("costUsd") },
      });
      if (pod.evidence.length)
        await db.insert(s.evidence).values(pod.evidence.map((e) => {
          const pub = new Date(e.date);
          return { podId, agentRole: e.agent_role, url: e.url, quote: e.quote, claim: e.claim, direction: e.direction === "+" ? 1 : -1, publishedAt: Number.isNaN(+pub) ? null : pub, retrievedAt: new Date(now) };
        }));
      await addSpend(db, now, pod.costs.costUsd, pod.costs.sandboxS);
      await db.update(s.pods).set({ status: "done", stage: "done", costSandboxS: pod.costs.sandboxS }).where(eq(s.pods.id, podId));

      let thesisId: string | undefined;
      if (core) {
        thesisId = id("th");
        await db.insert(s.theses).values({
          id: thesisId, conditionId, podId, pHat: core.pHat, c: core.c, pPost: core.pPost, side: core.side, edgeC: core.edgeC, sizeUsd: core.sizeUsd,
          rAnn: core.rAnn, rank: core.rank, catalysts: j.catalysts.map((x) => `${x.date} ${x.label}`), killCriteria: j.kill_criteria,
          createdAt: new Date(now), expiresAt: new Date(Math.min(market.endDate, now + 72 * 3_600_000)),
          detail: {
            thesis: j.thesis, pYes: j.p_hat, pMidYes: snap.mid, k: core.k, e: core.e, shares: core.shares, payoff: core.payoff,
            expectedProfit: core.expectedProfit, daysLeft: core.daysLeft, capped: j.capped, judgeConfidence: j.confidence, trigger,
            model: judgeModel, roleMix: pod.agents.filter((a) => a.ok).map((a) => a.role).join("+"),
          },
        });
        publish("thesis.created", { thesisId, conditionId, side: core.side, edgeC: core.edgeC, sizeUsd: core.sizeUsd });
      }
      publish("pod.done", { podId, conditionId, thesisId });
      return { podId, status: "done", thesisId };
    } catch (e) {
      await db.update(s.pods).set({ status: "failed" }).where(and(eq(s.pods.id, podId), eq(s.pods.status, "running"))); // never leave a pod `running`
      throw e;
    }
  });
}

/** Shortlist -> pods (initial) + stale theses -> pods (re-research triggers), inside the budget knobs. */
export async function researchShortlist(d: Deps, opts: { limit?: number; deadline?: number } = {}) {
  return withLock(d, "research-shortlist", 60 * 60_000, async () => {
    const { db, settings: st } = d, now = d.now();
    const th = await db.select().from(s.theses).orderBy(desc(s.theses.createdAt));
    const latest = new Map<string, (typeof th)[number]>();
    for (const t of th) if (!latest.has(t.conditionId)) latest.set(t.conditionId, t);

    const snaps = await latestSnaps(db, [...latest.keys()]);
    const mk = new Map((await db.select({ conditionId: s.markets.conditionId, status: s.markets.status, endDate: s.markets.endDate }).from(s.markets).where(inArray(s.markets.conditionId, [...latest.keys()]))).map((m) => [m.conditionId, m]));
    const todo: { id: string; trigger: Trigger }[] = [];
    for (const [cid, t] of latest) {
      const m = mk.get(cid), snap = snaps.get(cid), pm0 = (t.detail as { pMidYes?: number } | null)?.pMidYes;
      if (!m || m.status !== "active" || snap?.mid == null || pm0 == null) continue;
      const why = shouldReResearch({ mid: pm0, createdAt: t.createdAt.getTime(), resolvesAt: m.endDate?.getTime() ?? now }, now, snap.mid, catalystMs(t.catalysts), false)[0];
      if (why) todo.push({ id: cid, trigger: why === "PRICE_MOVE" ? "price-move" : why === "CATALYST_PASSED" ? "catalyst" : why === "STALE" ? "stale" : "manual" });
    }
    const failed = await failedRecently(db, now);
    for (const x of await shortlist(db, 20)) if (!latest.has(x.conditionId)) todo.push({ id: x.conditionId, trigger: "initial" });
    const picked = todo.filter((x) => !failed.has(x.id)).slice(0, opts.limit ?? todo.length);

    return runWaves(d, picked, opts.deadline);
  });
}

type Todo = { id: string; trigger: Trigger; opts?: ResearchOpts };
/** Pods in waves of maxConcurrentSandboxes/5; stops at the first budget refusal or outage, or when no pod can finish before `deadline`
 *  (epoch ms; shared by everything one host invocation runs, default = one function window from now). */
async function runWaves(d: Deps, picked: Todo[], deadline = d.now() + POD_WINDOW_MS) {
  const wave = Math.max(1, Math.floor(d.settings.budget.maxConcurrentSandboxes / 5));
  const res = { candidates: picked.length, done: 0, failed: 0, stopped: null as string | null, theses: [] as string[] };
  for (let i = 0; i < picked.length && !res.stopped; i += wave) {
    // a pod started now would be killed with the host function; the rest waits for the next run
    if (d.now() + POD_AGENTS_MS + POD_JUDGE_MS + WAVE_MARGIN_MS > deadline) { res.stopped = "WINDOW"; break; }
    for (const r of await Promise.all(picked.slice(i, i + wave).map((x) => researchMarket(d, x.id, x.trigger, x.opts)))) {
      if ("skipped" in r) { if (r.reason !== "LOCKED" && r.reason !== "NO_BOOK") res.stopped = r.reason; continue; }
      if (r.status === "done") res.done++; else res.failed++;
      if (r.thesisId) res.theses.push(r.thesisId);
      if (r.reason === "ANTHROPIC_OUTAGE") res.stopped = r.reason;
    }
  }
  return res;
}

/** Runs `matches` (minus markets whose pod failed in the last 24h) with the profile's steering. last_run_at advances only when every match ran, so a stopped run retries on the next tick. Locked per profile. */
export async function runProfile(d: Deps, p: ResearchProfile, matches: Pick<Match, "conditionId">[], deadline?: number) {
  return withLock(d, `research-profile:${p.id}`, 60 * 60_000, async () => {
    const failed = await failedRecently(d.db, d.now());
    const res = await runWaves(d, matches.filter((m) => !failed.has(m.conditionId)).map((m) => ({ id: m.conditionId, trigger: "profile", opts: { steering: p.steering, profileId: p.id } })), deadline);
    if (!res.stopped) await d.db.update(s.researchProfiles).set({ lastRunAt: new Date(d.now()) }).where(eq(s.researchProfiles.id, p.id));
    return res;
  });
}

/** Enabled scheduled profiles whose interval elapsed. Budget exhausted => stop; next tick retries. */
export async function runDueProfiles(d: Deps, deadline?: number) {
  const now = d.now(), ran: string[] = [];
  for (const p of await listProfiles(d.db)) {
    if (!p.enabled || p.everyMin == null || (p.lastRunAt && now - p.lastRunAt.getTime() < p.everyMin * 60_000)) continue;
    const r = await runProfile(d, p, await matchMarkets(d.db, p.filter, now), deadline);
    if ("skipped" in r) continue; // another run holds this profile
    ran.push(p.id);
    if (r.stopped) break;
  }
  return ran;
}

/** The cron `research` job: screener shortlist first, then due profiles unless the shortlist hit the budget. */
export async function researchCron(d: Deps) {
  const deadline = d.now() + POD_WINDOW_MS; // one window for the whole invocation, shortlist and profiles alike
  const r = await researchShortlist(d, { deadline });
  if ("skipped" in r || r.stopped) return r;
  return { ...r, profiles: await runDueProfiles(d, deadline) };
}

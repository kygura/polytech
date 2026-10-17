import { AnthropicOutageError, PodFailedError, modelFor, runPod, type AgentResult } from "@pm/agents";
import { canStartPod, crowd, shouldReResearch, sizeTrade } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { outageDowngrade } from "./autonomy";
import { categoryConfidence } from "./calib";
import { DAY, feeOf, toMarket, today, withLock, type Deps, type Skipped } from "./deps";
import { publish } from "./events";
import { latestSnaps, shortlist } from "./screen";

export type Trigger = "initial" | "price-move" | "catalyst" | "stale" | "manual";
export type ResearchResult = Skipped | { podId: string; status: "done" | "failed"; thesisId?: string; reason?: string };

const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;
const catalystMs = (cs: string[]) => cs.map((c) => Date.parse(c.slice(0, 10))).filter(Number.isFinite);

const agentRows = (podId: string, agents: AgentResult[]) =>
  agents.map((a): typeof s.agentRuns.$inferInsert =>
    a.ok
      ? { podId, role: a.role, model: a.model, status: "ok", outputJson: a.run.output, usage: a.run.usage, durationS: a.run.durationS }
      : { podId, role: a.role, model: a.model, status: "failed", outputJson: { error: a.error } });

const FAILED_SKIP_MS = 6 * 3_600_000; // poison-market guard: no initial re-pick this soon after a failed pod

const addSpend = (db: Deps["db"], now: number, usd: number, sandboxS: number) =>
  db.insert(s.spend).values({ day: today(now), anthropicUsd: usd, sandboxS })
    .onConflictDoUpdate({ target: s.spend.day, set: { anthropicUsd: sql`${s.spend.anthropicUsd} + ${usd}`, sandboxS: sql`${s.spend.sandboxS} + ${sandboxS}` } });

/** Budget check -> pod -> judge -> sizing against the latest stored book -> `theses` row. */
export async function researchMarket(d: Deps, conditionId: string, trigger: Trigger = "manual"): Promise<ResearchResult> {
  return withLock(d, `research:${conditionId}`, 30 * 60_000, async (): Promise<ResearchResult> => {
    const { settings: st, db } = d, now = d.now();
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
      // reap pods stuck `running` past their sandbox timeout (crash/timeout) so they stop eating the budget
      await db.update(s.pods).set({ status: "failed" })
        .where(and(eq(s.pods.status, "running"), lt(s.pods.startedAt, new Date(now - (Math.ceil(5 / conc) * st.budget.sandboxTimeoutMin + 10) * 60_000))));
      const [{ n: podsToday }] = await db.select({ n: count() }).from(s.pods).where(gte(s.pods.startedAt, dayStart)) as [{ n: number }];
      const [{ n: running }] = await db.select({ n: count() }).from(s.pods).where(eq(s.pods.status, "running")) as [{ n: number }];
      const sp = (await db.select().from(s.spend).where(eq(s.spend.day, today(now))))[0];
      const ok = canStartPod(
        { podsToday, activeSandboxes: running * conc, spendTodayUsd: sp?.anthropicUsd ?? 0 },
        { maxPodsPerDay: st.budget.maxPodsPerDay, maxConcurrentSandboxes: st.budget.maxConcurrentSandboxes, dailySpendCapUsd: st.budget.dailySpendCapUsd },
        conc,
      );
      if (!ok.ok) return { skipped: true, reason: ok.reason! };
      await db.insert(s.pods).values({ id: podId, conditionId, startedAt: new Date(now), status: "running", trigger });
    } finally {
      await rel();
    }
    publish("pod.started", { podId, conditionId, trigger });

    try {
      const market = toMarket(mrow);
      const sibRows = mrow.eventId ? await db.select().from(s.markets).where(eq(s.markets.eventId, mrow.eventId)) : [];
      const book = { bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid };
      let pod;
      try {
        pod = await runPod({
          market, siblings: sibRows.filter((r) => r.conditionId !== conditionId).slice(0, 10).map(toMarket), book, runner: d.runner, judge: d.judge,
          settings: { models: st.models, concurrency: conc, timeoutMs: st.budget.sandboxTimeoutMin * 60_000, exaCallCap: st.budget.exaCallsPerPod, core: st },
          onAgentDone: (a) => publish("pod.agent", { podId, role: a.role, ok: a.ok }),
        });
      } catch (e) {
        const outage = e instanceof AnthropicOutageError || (e instanceof PodFailedError && (e.cause instanceof AnthropicOutageError || e.agents.some((a) => !a.ok && a.outage)));
        if (e instanceof PodFailedError) {
          // keep what the agents already cost / produced
          if (e.agents.length) await db.insert(s.agentRuns).values(agentRows(podId, e.agents));
          const ok = e.agents.flatMap((a) => (a.ok ? [a] : []));
          await addSpend(db, now, ok.reduce((t, a) => t + a.run.usage.costUsd, 0), ok.reduce((t, a) => t + a.run.sandboxS, 0));
        }
        await db.update(s.pods).set({ status: "failed" }).where(eq(s.pods.id, podId));
        const lowered = outage ? await outageDowngrade(d) : null;
        const reason = outage ? "ANTHROPIC_OUTAGE" : "POD_FAILED";
        publish("pod.failed", { podId, conditionId, reason, error: scrub(String(e instanceof Error ? e.message : e)), downgradedTo: lowered });
        return { podId, status: "failed", reason };
      }

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
      await db.insert(s.agentRuns).values([
        ...agentRows(podId, pod.agents),
        {
          podId, role: "judge", model: modelFor("judge", st.models), status: "ok", outputJson: j,
          usage: { inputTokens: pod.costs.inputTokens - sum("inputTokens"), outputTokens: pod.costs.outputTokens - sum("outputTokens"), costUsd: pod.costs.costUsd - sum("costUsd") },
        },
      ]);
      if (pod.evidence.length)
        await db.insert(s.evidence).values(pod.evidence.map((e) => {
          const pub = new Date(e.date);
          return { podId, agentRole: e.agent_role, url: e.url, quote: e.quote, claim: e.claim, direction: e.direction === "+" ? 1 : -1, publishedAt: Number.isNaN(+pub) ? null : pub, retrievedAt: new Date(now) };
        }));
      await addSpend(db, now, pod.costs.costUsd, pod.costs.sandboxS);
      await db.update(s.pods).set({ status: "done", costSandboxS: pod.costs.sandboxS }).where(eq(s.pods.id, podId));

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
            model: modelFor("judge", st.models), roleMix: pod.agents.filter((a) => a.ok).map((a) => a.role).join("+"),
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
export async function researchShortlist(d: Deps, opts: { limit?: number } = {}) {
  return withLock(d, "research-shortlist", 60 * 60_000, async () => {
    const { db, settings: st } = d, now = d.now();
    const th = await db.select().from(s.theses).orderBy(desc(s.theses.createdAt));
    const latest = new Map<string, (typeof th)[number]>();
    for (const t of th) if (!latest.has(t.conditionId)) latest.set(t.conditionId, t);

    const snaps = await latestSnaps(db, [...latest.keys()]);
    const mk = new Map((await db.select().from(s.markets)).map((m) => [m.conditionId, m]));
    const todo: { id: string; trigger: Trigger }[] = [];
    for (const [cid, t] of latest) {
      const m = mk.get(cid), snap = snaps.get(cid), pm0 = (t.detail as { pMidYes?: number } | null)?.pMidYes;
      if (!m || m.status !== "active" || snap?.mid == null || pm0 == null) continue;
      const why = shouldReResearch({ mid: pm0, createdAt: t.createdAt.getTime(), resolvesAt: m.endDate?.getTime() ?? now }, now, snap.mid, catalystMs(t.catalysts), false)[0];
      if (why) todo.push({ id: cid, trigger: why === "PRICE_MOVE" ? "price-move" : why === "CATALYST_PASSED" ? "catalyst" : why === "STALE" ? "stale" : "manual" });
    }
    const failedRecently = new Set((await db.select({ c: s.pods.conditionId }).from(s.pods)
      .where(and(eq(s.pods.status, "failed"), gte(s.pods.startedAt, new Date(now - FAILED_SKIP_MS))))).map((r) => r.c));
    for (const x of await shortlist(db, 20)) if (!latest.has(x.conditionId) && !failedRecently.has(x.conditionId)) todo.push({ id: x.conditionId, trigger: "initial" });
    const picked = todo.slice(0, opts.limit ?? todo.length);

    const wave = Math.max(1, Math.floor(st.budget.maxConcurrentSandboxes / 5));
    const res = { candidates: picked.length, done: 0, failed: 0, stopped: null as string | null, theses: [] as string[] };
    for (let i = 0; i < picked.length && !res.stopped; i += wave)
      for (const r of await Promise.all(picked.slice(i, i + wave).map((x) => researchMarket(d, x.id, x.trigger)))) {
        if ("skipped" in r) { if (r.reason !== "LOCKED" && r.reason !== "NO_BOOK") res.stopped = r.reason; continue; }
        if (r.status === "done") res.done++; else res.failed++;
        if (r.thesisId) res.theses.push(r.thesisId);
        if (r.reason === "ANTHROPIC_OUTAGE") res.stopped = r.reason;
      }
    return res;
  });
}

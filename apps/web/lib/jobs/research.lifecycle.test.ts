import { costUsd, fakeJudge, fakeRunner, modelFor, type AgentRunner, type Judge } from "@pm/agents";
import { DEFAULT_STEERING, type ResearchProfile } from "@pm/core";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POD_WINDOW_MS, deps, latestSnaps, read, requestCancel, researchMarket, runProfile, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

let d: Deps, markets: string[];
const events: string[] = [];
const rows = (podId: string) => d.db.select().from(s.agentRuns).where(eq(s.agentRuns.podId, podId)).orderBy(asc(s.agentRuns.id));
const pod = async (id: string) => (await d.db.select().from(s.pods).where(eq(s.pods.id, id)))[0]!;
const withRunner = (runner: AgentRunner) => { d = { ...d, runner }; };
const withJudge = (judge: Judge) => { d = { ...d, judge }; };
const spend = async () => (await d.db.select().from(s.spend)).reduce((t, r) => t + r.anthropicUsd, 0);
const COST = 0.5; // every completed fake agent reports this, so spend assertions are exact
const paid: AgentRunner = async (role, brief, o) => { const r = await fakeRunner(role, brief, o); return { ...r, usage: { inputTokens: 1000, outputTokens: 100, costUsd: COST } }; };
const blocked = (o: { signal?: AbortSignal }) => new Promise<never>((_, rej) => o.signal?.addEventListener("abort", () => rej(new Error("cancelled")), { once: true }));
const model = (r: string) => modelFor(r as never, d.settings.models);
/** Starts a pod and returns its id once `ready(podId)` holds. */
const waitFor = async (what: () => Promise<string | undefined>) => {
  for (let i = 0; i < 300; i++) { const v = await what(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout waiting");
};
const runningRow = (role: string) => async () => (await d.db.select().from(s.agentRuns).where(eq(s.agentRuns.role, role))).find((r) => r.status === "running")?.podId;

beforeAll(async () => {
  let t = Date.parse("2026-10-15T12:00:00Z");
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge });
  subscribe((e) => events.push(e.type));
  await sweepUniverse(d); await snapshotBooks(d, "all");
  const all = (await d.db.select({ c: s.markets.conditionId }).from(s.markets).where(eq(s.markets.status, "active"))).map((r) => r.c);
  const snaps = await latestSnaps(d.db, all);
  markets = all.filter((c) => snaps.get(c)?.book && snaps.get(c)?.mid != null).slice(0, 4); // decoupled from screening
}, 60_000);

describe("research lifecycle", () => {
  it("the brief carries the rules text fetched from Gamma (the db stores only its hash)", async () => {
    const mrow = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, markets[3]!)))[0]!;
    const rules = (await d.pm.market(mrow.pmId!))?.rules ?? "";
    expect(rules.length).toBeGreaterThan(20);
    const briefs: string[] = [];
    withRunner(async (role, brief, o) => (briefs.push(JSON.stringify(brief)), fakeRunner(role, brief, o)));
    const res = await researchMarket(d, markets[3]!, "manual");
    if ("skipped" in res) throw new Error(res.reason);
    expect(briefs.length).toBeGreaterThan(0);
    expect(briefs.every((b) => b.includes(JSON.stringify(rules.slice(0, 40)).slice(1, -1)))).toBe(true);
    withRunner(fakeRunner);
  });

  it("agent rows go running -> ok with tool calls, stage walks rules -> agents -> judge -> sizing -> done", async () => {
    const seen: Record<string, string> = {}, stages: (string | null)[] = [];
    withRunner(async (role, brief, o) => {
      const r = (await d.db.select().from(s.agentRuns).where(eq(s.agentRuns.role, role))).at(-1);
      seen[role] = r?.status ?? "none"; // our own row exists and is running while we run
      stages.push((await d.db.select().from(s.pods).where(eq(s.pods.status, "running")))[0]?.stage ?? null);
      return fakeRunner(role, brief, o);
    });
    const stageEvents: string[] = [];
    const un = subscribe((e) => { if (e.type === "pod.stage") stageEvents.push((e.payload as { stage: string }).stage); });
    const res = await researchMarket(d, markets[0]!, "manual");
    un();
    if ("skipped" in res) throw new Error(res.reason);
    expect(res.status).toBe("done");
    expect(Object.values(seen)).toEqual(["running", "running", "running", "running", "running"]);
    expect(new Set(stages)).toEqual(new Set(["agents"]));
    expect(stageEvents).toEqual(["rules", "agents", "judge", "sizing"]);

    const p = await pod(res.podId);
    expect(p).toMatchObject({ status: "done", stage: "done", cancelRequestedAt: null });
    const runs = await rows(res.podId);
    expect(runs.map((r) => r.role).sort()).toEqual(["base_rate", "judge", "news", "red_team", "rules", "source"]);
    for (const r of runs) {
      expect(r.status).toBe("ok");
      expect(r.startedAt).toBeTruthy();
      expect(r.finishedAt!.getTime()).toBeGreaterThanOrEqual(r.startedAt!.getTime());
      expect(r.durationS).not.toBeNull();
    }
    expect(runs.find((r) => r.role === "news")!.toolCalls!.map((c) => c.name)).toEqual(["mcp__exa__search", "mcp__exa__contents"]);
    expect(runs.find((r) => r.role === "judge")!.usage).toBeTruthy();

    const det = (await read.podDetail(d, res.podId))!;
    expect(det.pod).toMatchObject({ status: "done", stage: "done" });
    expect(det.agents).toHaveLength(6);
    expect(det.agents.find((a) => a.role === "source")!.toolCalls).toHaveLength(2);
    expect(det.evidence.length).toBeGreaterThan(0);
    expect(det.budget.exaCallsPerPod).toBe(d.settings.budget.exaCallsPerPod);
  });

  it("cancel mid-run: agents cancelled, pod cancelled, stage kept, no thesis; spend = completed + flat guess for the cut-off agent", async () => {
    withRunner((role, brief, o) => (role === "news" ? blocked(o) : paid(role, brief, o)));
    const before = await spend();
    const run = researchMarket(d, markets[1]!, "manual", { cancelPollMs: 20 });
    const podId = await waitFor(runningRow("news"));
    expect(await requestCancel(d, podId)).toBe("ok");
    expect(await run).toMatchObject({ podId, status: "cancelled" });

    const p = await pod(podId);
    expect(p).toMatchObject({ status: "cancelled", stage: "agents" });
    expect(p.cancelRequestedAt).toBeTruthy();
    const runs = await rows(podId);
    expect(runs.find((r) => r.role === "news")!.status).toBe("cancelled");
    expect(runs.some((r) => r.status === "running")).toBe(false);
    expect(runs.some((r) => r.role === "judge")).toBe(false);
    expect(await d.db.select().from(s.theses).where(eq(s.theses.podId, podId))).toHaveLength(0);
    expect(events).toContain("pod.cancelled");
    expect((await spend()) - before).toBeCloseTo(4 * COST + costUsd(model("news"), 150_000, 10_000), 9);

    // not running any more: second cancel is refused, unknown pod is not found
    expect(await requestCancel(d, podId)).toBe("not_running");
    expect(await requestCancel(d, "pod_nope")).toBe("not_found");
  });

  it("cancel during the judge: the judge call receives the signal and stops; spend = 5 agents + flat judge guess", async () => {
    withRunner(paid);
    let got: AbortSignal | undefined;
    withJudge((i) => { got = i.signal; return blocked(i) as never; });
    const before = await spend();
    const run = researchMarket(d, markets[2]!, "manual", { cancelPollMs: 20 });
    const podId = await waitFor(runningRow("judge"));
    await requestCancel(d, podId);
    expect(await run).toMatchObject({ podId, status: "cancelled" });
    expect(got?.aborted).toBe(true);
    expect(await pod(podId)).toMatchObject({ status: "cancelled", stage: "judge" });
    expect((await rows(podId)).find((r) => r.role === "judge")!.status).toBe("cancelled");
    expect((await spend()) - before).toBeCloseTo(5 * COST + costUsd(model("judge"), 20_000, 2_000), 9);
    withJudge(fakeJudge);
  });

  it("cancel that lands after the judge (sizing) is honoured: cancelled, no thesis, spend still recorded", async () => {
    withRunner(paid);
    let podId = "";
    withJudge(async (i) => { // the poller is effectively off (60 s), so only the pre-thesis re-check can see this
      podId = (await d.db.select().from(s.pods).where(eq(s.pods.status, "running")))[0]!.id;
      expect(await requestCancel(d, podId)).toBe("ok");
      return fakeJudge(i);
    });
    const before = await spend();
    const res = await researchMarket(d, markets[3]!, "manual", { cancelPollMs: 60_000 });
    expect(res).toMatchObject({ podId, status: "cancelled" });
    expect((await pod(podId)).status).toBe("cancelled");
    expect(await d.db.select().from(s.theses).where(eq(s.theses.podId, podId))).toHaveLength(0);
    expect((await spend()) - before).toBeCloseTo(5 * COST, 9);
    withJudge(fakeJudge);
  });

  it("a cancelled market is not relaunched by the next wave (24 h poison guard)", async () => {
    const [cancelledPod] = (await d.db.select().from(s.pods).where(eq(s.pods.status, "cancelled")));
    const p = { id: "prof_x", steering: DEFAULT_STEERING } as unknown as ResearchProfile;
    expect(await runProfile(d, p, [{ conditionId: cancelledPod!.conditionId }])).toMatchObject({ candidates: 0 });
  });

  it("the reaper also ends the dead pod's running agent rows", async () => {
    withRunner(fakeRunner);
    await d.db.insert(s.pods).values({ id: "pod_dead", conditionId: "0xdead", startedAt: new Date(d.now() - POD_WINDOW_MS - 120_000), status: "running", trigger: "manual", stage: "agents" });
    await d.db.insert(s.agentRuns).values({ podId: "pod_dead", role: "news", model: "m", status: "running", startedAt: new Date(d.now() - POD_WINDOW_MS - 120_000) });
    const res = await researchMarket(d, markets[0]!, "manual");
    if ("skipped" in res) throw new Error(res.reason);
    expect((await pod("pod_dead")).status).toBe("failed");
    expect((await rows("pod_dead"))[0]).toMatchObject({ status: "failed" });
    expect((await rows("pod_dead"))[0]!.finishedAt).toBeTruthy();
  });

  it("agent failure still yields >=3 ok -> pod done; a failed agent's row is failed, not running", async () => {
    withRunner((role, brief, o) => (role === "news" ? Promise.reject(new Error("boom")) : fakeRunner(role, brief, o)));
    const res = await researchMarket(d, markets[2]!, "manual");
    if ("skipped" in res) throw new Error(res.reason);
    expect(res.status).toBe("done");
    expect((await rows(res.podId)).find((r) => r.role === "news")).toMatchObject({ status: "failed" });
  });
});

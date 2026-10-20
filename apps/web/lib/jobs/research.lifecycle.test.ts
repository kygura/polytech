import { fakeJudge, fakeRunner, type AgentRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { deps, latestSnaps, read, requestCancel, researchMarket, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

let d: Deps, markets: string[];
const events: string[] = [];
const rows = (podId: string) => d.db.select().from(s.agentRuns).where(eq(s.agentRuns.podId, podId)).orderBy(asc(s.agentRuns.id));
const pod = async (id: string) => (await d.db.select().from(s.pods).where(eq(s.pods.id, id)))[0]!;
const withRunner = (runner: AgentRunner) => { d = { ...d, runner }; };

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

  it("cancel mid-run: running agents cancelled, pod cancelled, stage kept, no thesis, completed spend recorded", async () => {
    withRunner((role, brief, o) =>
      role === "news"
        ? new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(new Error("cancelled")), { once: true }))
        : fakeRunner(role, brief, { ...o, signal: o.signal }));
    const spendBefore = (await d.db.select().from(s.spend)).reduce((t, r) => t + r.anthropicUsd, 0);
    const run = researchMarket(d, markets[1]!, "manual", { cancelPollMs: 20 });
    // wait for the pod + the blocked news agent to be running, then cancel through the API helper
    let podId = "";
    for (let i = 0; i < 200 && !podId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const news = (await d.db.select().from(s.agentRuns).where(eq(s.agentRuns.role, "news")))
        .find((r) => r.status === "running");
      if (news) podId = news.podId;
    }
    expect(podId).not.toBe("");
    expect(await requestCancel(d, podId)).toBe("ok");
    const res = await run;
    expect(res).toMatchObject({ podId, status: "cancelled" });

    const p = await pod(podId);
    expect(p.status).toBe("cancelled");
    expect(p.stage).toBe("agents");
    expect(p.cancelRequestedAt).toBeTruthy();
    const runs = await rows(podId);
    expect(runs.find((r) => r.role === "news")!.status).toBe("cancelled");
    expect(runs.some((r) => r.status === "running")).toBe(false);
    expect(runs.some((r) => r.role === "judge")).toBe(false);
    expect(await d.db.select().from(s.theses).where(eq(s.theses.podId, podId))).toHaveLength(0);
    expect(events).toContain("pod.cancelled");
    expect((await d.db.select().from(s.spend)).reduce((t, r) => t + r.anthropicUsd, 0)).toBeGreaterThanOrEqual(spendBefore);

    // not running any more: second cancel is refused, unknown pod is not found
    expect(await requestCancel(d, podId)).toBe("not_running");
    expect(await requestCancel(d, "pod_nope")).toBe("not_found");
  });

  it("agent failure still yields >=3 ok -> pod done; a failed agent's row is failed, not running", async () => {
    withRunner((role, brief, o) => (role === "news" ? Promise.reject(new Error("boom")) : fakeRunner(role, brief, o)));
    const res = await researchMarket(d, markets[2]!, "manual");
    if ("skipped" in res) throw new Error(res.reason);
    expect(res.status).toBe("done");
    expect((await rows(res.podId)).find((r) => r.role === "news")).toMatchObject({ status: "failed" });
  });
});

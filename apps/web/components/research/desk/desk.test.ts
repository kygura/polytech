import { describe, expect, it } from "vitest";
import { failText, freeSlots, lastText, mss, progress, pump, resultText, stageText, startOutcome, triageBadge, unseen, type Run, type Verdict } from "./desk";

const ag = (done: number, failed = 0, total = 5) => ({ total, done, failed });
const run = (p: Partial<Run>): Run => ({
  podId: "p", conditionId: "0x1", question: "q", trigger: "manual", status: "running", stage: null, error: null, startedAt: 0, agents: ag(0), verdict: null, judge: null, ...p,
} as Run);

describe("progress / stageText", () => {
  it("maps stages to percent; agents scale with finished agents", () => {
    expect(progress(run({ stage: "rules" }))).toBe(10);
    expect(progress(run({ stage: "agents", agents: ag(0) }))).toBe(15);
    expect(progress(run({ stage: "agents", agents: ag(2, 1) }))).toBe(48);
    expect(progress(run({ stage: "agents", agents: ag(5) }))).toBe(70);
    expect(progress(run({ stage: "judge" }))).toBe(80);
    expect(progress(run({ stage: "sizing" }))).toBe(92);
    expect(progress(run({ status: "done", stage: "sizing" }))).toBe(100);
    expect(progress(run({ stage: null }))).toBe(5);
  });
  it("failed and cancelled freeze where they stopped", () => {
    expect(progress(run({ status: "failed", stage: "judge" }))).toBe(80);
    expect(progress(run({ status: "cancelled", stage: "agents", agents: ag(1, 0, 5) }))).toBe(26);
  });
  it("labels", () => {
    expect(stageText(run({ stage: "agents", agents: ag(3) }))).toBe("Analysts researching · 3/5 done");
    expect(stageText(run({ stage: "agents", agents: ag(3, 1) }))).toBe("Analysts researching · 3/5 done · 1 failed");
    expect(stageText(run({ stage: "judge" }))).toBe("Judge weighing the evidence");
  });
});

describe("failText", () => {
  it("reasons in plain words, first agent error only", () => {
    expect(failText("TIMEOUT: TIMEOUT: judge")).toBe("Ran out of time");
    expect(failText("ANTHROPIC_OUTAGE: 529 overloaded")).toBe("Anthropic API overloaded");
    expect(failText("POD_FAILED: 5/5 agents failed: exa 401 | parse error")).toBe("5 of 5 analysts failed: exa 401");
    expect(failText("ERROR: db down")).toBe("db down");
    expect(failText(null)).toBe("Failed");
  });
});

describe("result text", () => {
  it("verdict, judge-only, nothing", () => {
    const v = { side: "YES" as const, pYes: 0.47, midAtThesis: 0.4, edgeC: 7, sizeUsd: 50.2, confidence: 0.3, thesis: "" };
    expect(resultText(run({ status: "done", verdict: v }))).toBe("Fair value 47¢ vs 40¢ at research · Edge +7¢ on YES · Suggested $50");
    expect(resultText(run({ status: "done", judge: { pYes: 0.41, thesis: "" } }))).toBe("Fair value 41¢ — no edge worth trading");
    expect(lastText(run({ status: "done", verdict: { ...v, edgeC: 3.25, side: "NO" } }))).toBe("Edge +3.3¢ NO");
    expect(lastText(run({ stage: "judge" }))).toBe("Running 80%");
  });
  it("mss", () => {
    expect(mss(0)).toBe("0:00");
    expect(mss(185_400)).toBe("3:05");
  });
});

describe("queue", () => {
  const q = [{ id: "a", question: "A" }, { id: "b", question: "B" }, { id: "c", question: "C" }];
  it("starts up to the free slots, none while held", () => {
    expect(freeSlots({ running: 3, maxRunning: 5 }, 1)).toBe(1);
    expect(freeSlots({ running: 5, maxRunning: 5 }, 1)).toBe(0);
    expect(freeSlots(null, 0)).toBe(0);
    expect(pump(q, 2, false)).toEqual({ start: q.slice(0, 2), rest: q.slice(2) });
    expect(pump(q, 5, true)).toEqual({ start: [], rest: q });
    expect(pump([], 3, false).start).toEqual([]);
  });
  it("409 slots requeues, other 409s do not start", () => {
    expect(startOutcome(202, { })).toEqual({ kind: "started" });
    expect(startOutcome(409, { reason: "MAX_CONCURRENT_SANDBOXES" })).toEqual({ kind: "requeue" });
    expect(startOutcome(409, { reason: "LOCKED" })).toEqual({ kind: "not_started", reason: "already being researched" });
    expect(startOutcome(500, { error: "research failed: x" })).toEqual({ kind: "not_started", reason: "research failed: x" });
    expect(startOutcome(null, null).kind).toBe("not_started");
  });
  it("a start counts as running until the poll shows its pod", () => {
    const p = [{ id: "a", at: 10_000, known: ["pod_old"] }, { id: "b", at: 10_000, known: [] }];
    expect(unseen(p, [{ conditionId: "a", podId: "pod_old" }], 12_000)).toEqual(p); // older pod of the same market
    expect(unseen(p, [{ conditionId: "a", podId: "pod_new" }], 12_000)).toEqual([p[1]]); // whatever the server clock says
    expect(unseen(p, [], 80_000)).toEqual([]);
  });
});

describe("triageBadge", () => {
  const v: Verdict = { conditionId: "0x1", verdict: "skip", score: 0, reason: "wide spread", failedRules: ["WIDE_SPREAD", "X"], model: null, createdAt: "" };
  it("skip lists failed rules in words; research shows the score", () => {
    expect(triageBadge(v)).toEqual({ text: "Skip", tone: "muted", why: "Spread over 10¢: entry cost eats the edge\nX" });
    expect(triageBadge({ ...v, verdict: "research", score: 0.83, failedRules: [], reason: "clear resolution" })).toEqual({ text: "Worth researching 0.8", tone: "up", why: "clear resolution" });
    expect(triageBadge(undefined)).toBeNull();
  });
});

describe("no-trade verdicts", () => {
  it("a thesis sized at $0 or with no positive edge reads as no trade", () => {
    const v = { side: "YES" as const, pYes: 0.36, midAtThesis: 0.34, edgeC: -1.1, sizeUsd: 0, confidence: 0.4, thesis: null };
    expect(resultText({ verdict: v, judge: null })).toBe("Fair value 36¢ vs 34¢ at research — no trade: the gap does not survive fees and confidence");
    expect(lastText({ status: "done", stage: "done", agents: { total: 5, done: 5, failed: 0 }, verdict: v, judge: null })).toBe("Fair 36¢ · no trade");
  });
});

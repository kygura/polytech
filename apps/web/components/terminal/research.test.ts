import { describe, expect, it } from "vitest";
import { clock, edgeNow, failText, refusalText, researchPct, verdictLine, verdictOf, viewState, type LiveRun } from "./research";

const run = (o: Partial<LiveRun> = {}): LiveRun => ({
  podId: "pod_1", conditionId: "0x1", status: "running", stage: "agents", error: null, startedAt: 2_000,
  agents: { total: 5, done: 3, failed: 0 }, verdict: null, judge: null, ...o,
});
const thesis = { podId: "pod_0", createdAt: 1_000, side: "YES" as const, pHat: 0.47, pYes: 0.47, edgeC: 6, sizeUsd: 50 };

describe("research progress", () => {
  it("stage -> percent", () => {
    expect([researchPct("rules"), researchPct("agents", 0, 5), researchPct("agents", 3, 5), researchPct("agents", 5, 5), researchPct("judge"), researchPct("sizing"), researchPct("done")])
      .toEqual([10, 15, 48, 70, 80, 92, 100]);
    expect(researchPct("agents", 9, 5)).toBe(70);
    expect(researchPct("agents", 1, 0)).toBe(15);
    expect(researchPct(null)).toBe(5);
  });
  it("clock", () => {
    expect([clock(0), clock(102), clock(725.9), clock(3729), clock(-4)]).toEqual(["0:00", "1:42", "12:05", "1:02:09", "0:00"]);
  });
});

describe("plain words", () => {
  it("refusal reasons", () => {
    expect(refusalText("DAILY_SPEND_CAP")).toBe("Daily research budget used up (Settings → Research budget)");
    expect(refusalText("RESEARCH_DISABLED")).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(refusalText("MAX_CONCURRENT_SANDBOXES", undefined, { running: 5, maxRunning: 5 })).toBe("5 runs already going — try again when one finishes");
    expect(refusalText("MAX_CONCURRENT_SANDBOXES")).toMatch(/try again when one finishes/);
    expect(refusalText("SOMETHING_NEW", "research not started: SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(refusalText(null)).toBe("Research did not start");
  });
  it("failure reasons", () => {
    expect(failText(null)).toMatch(/stopped before it finished/);
    expect(failText("ANTHROPIC_OUTAGE: 529 overloaded")).toBe("the AI provider was unavailable");
    expect(failText("TIMEOUT: judge")).toBe("it took too long and was stopped");
    expect(failText("POD_FAILED: 3/5 agents failed: boom")).toBe("3 of 5 analysts failed");
    expect(failText("ERROR: x")).toBe("an unexpected error");
  });
});

describe("viewState", () => {
  const base = { thesis: null, pod: null, agents: [], run: null };
  it("nothing yet", () => expect(viewState(base)).toEqual({ k: "none" }));
  it("running from the live poll, with progress", () => {
    expect(viewState({ ...base, thesis, run: run() })).toMatchObject({ k: "running", podId: "pod_1", pct: 48, done: 3, total: 5, stage: "agents" });
  });
  it("running from the detail before the poll catches up", () => {
    expect(viewState({ ...base, pod: { id: "pod_2", status: "running", startedAt: 3_000 }, run: run({ status: "done", startedAt: 1_500 }) })).toMatchObject({ k: "running", podId: "pod_2", pct: 5 });
  });
  it("a failed run newer than the thesis wins; an older one does not", () => {
    expect(viewState({ ...base, thesis, run: run({ status: "failed", error: "TIMEOUT: x" }) })).toEqual({ k: "failed", error: "TIMEOUT: x" });
    expect(viewState({ ...base, thesis, run: run({ status: "failed", startedAt: 500 }) })).toMatchObject({ k: "thesis", pYes: 0.47 });
  });
  it("cancelled with no thesis", () => expect(viewState({ ...base, run: run({ status: "cancelled" }) })).toEqual({ k: "cancelled" }));
  it("done, no thesis: judge only (live poll or the detail's judge row)", () => {
    expect(viewState({ ...base, run: run({ status: "done", judge: { pYes: 0.41, thesis: null } }) })).toEqual({ k: "judge", pYes: 0.41, at: 2_000 });
    expect(viewState({ ...base, pod: { id: "p", status: "done", startedAt: 9 }, agents: [{ role: "news", probability: 0.3 }, { role: "judge", probability: 0.4 }] })).toEqual({ k: "judge", pYes: 0.4, at: 9 });
  });
  it("done with a verdict newer than the detail's thesis", () => {
    expect(viewState({ ...base, thesis, run: run({ status: "done", verdict: { side: "NO", pYes: 0.3, midAtThesis: 0.4, edgeC: 8, sizeUsd: 20, confidence: 0.5, thesis: null } }) }))
      .toEqual({ k: "thesis", pYes: 0.3, side: "NO", sizeUsd: 20, edgeC: 8, at: 2_000 });
  });
  it("old thesis rows without pYes: pHat is on the thesis side", () => {
    expect(viewState({ ...base, thesis: { ...thesis, side: "NO", pHat: 0.7, pYes: null } })).toMatchObject({ k: "thesis", pYes: expect.closeTo(0.3, 9), side: "NO" });
  });
});

describe("edgeNow", () => {
  it("fair value of the side minus the ask minus the fee, in cents", () => {
    expect(edgeNow(0.47, "YES", 0.4, 0)).toBeCloseTo(7, 9);
    expect(edgeNow(0.47, "YES", 0.4, 0.04)).toBeCloseTo(7 - 0.04 * 0.4 * 0.6 * 100, 9);
    expect(edgeNow(0.3, "NO", 0.61, 0)).toBeCloseTo(9, 9);
    expect(edgeNow(0.3, "NO", null, 0)).toBeNull();
  });
});

describe("verdict", () => {
  const th = { k: "thesis" as const, pYes: 0.006, side: "YES" as const, sizeUsd: 0, edgeC: 0.2, at: 1 };
  it("a thesis that sized to $0 is a pass, however the gap reads", () => {
    expect(verdictOf(th, 0.2)).toEqual({ k: "pass", side: null, edgeC: null, ret: null });
    expect(verdictOf({ k: "judge", pYes: 0.5, at: 1 }, null)).toMatchObject({ k: "pass" });
  });
  it("a sized thesis trades while the live edge clears 1¢, else the edge is gone", () => {
    expect(verdictOf({ ...th, pYes: 0.5, sizeUsd: 40, edgeC: 4 }, 3)).toEqual({ k: "trade", side: "YES", edgeC: 3, ret: expect.closeTo(0.03 / 0.47, 9) });
    expect(verdictOf({ ...th, sizeUsd: 40, edgeC: 4 }, null)).toMatchObject({ k: "trade", edgeC: 4 });
    expect(verdictOf({ ...th, sizeUsd: 40, edgeC: 4 }, 0.4)).toMatchObject({ k: "gone" });
  });
  it("return on the stake: a 3¢ edge on a NO worth 99¢ costs 96¢", () => {
    expect(verdictOf({ ...th, pYes: 0.01, side: "NO", sizeUsd: 40, edgeC: 3 }, null)!.ret).toBeCloseTo(0.03 / 0.96, 9);
  });
  it("no verdict before research finishes", () => {
    expect(verdictOf(null, null)).toBeNull();
    expect(verdictOf({ k: "none" }, null)).toBeNull();
    expect(verdictOf({ k: "failed", error: null }, null)).toBeNull();
  });
  it("verdict line: the thesis's first sentence", () => {
    expect(verdictLine("Fairly priced: 0.6¢ vs 0.4¢ is inside our noise. The Fed raised…")).toBe("Fairly priced: 0.6¢ vs 0.4¢ is inside our noise.");
    expect(verdictLine("no full stop")).toBe("no full stop");
    expect(verdictLine("  ")).toBeNull();
  });
});

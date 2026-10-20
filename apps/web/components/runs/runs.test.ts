import { describe, expect, it } from "vitest";
import { agentDurS, atBottom, blindMean, byRole, clock, costRatio, elapsedS, podBudget, retryIds, stageIndex, stepper, tailStep, usd1s } from "./runs";

describe("stage stepper", () => {
  it("indexes stages; unknown / null = first", () => {
    expect(["rules", "agents", "judge", "sizing", "done"].map(stageIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(stageIndex(null)).toBe(0);
    expect(stageIndex("weird")).toBe(0);
  });
  it("live: done before, current, pending after", () => {
    expect(stepper("judge", "running").map((n) => n.state)).toEqual(["done", "done", "current", "pending", "pending"]);
  });
  it("done: everything complete", () => {
    expect(stepper("done", "done").every((n) => n.state === "done")).toBe(true);
  });
  it("failed / cancelled stop at the stage reached with the end marker", () => {
    const f = stepper("agents", "failed");
    expect(f.map((n) => n.label)).toEqual(["rules", "✕ failed"]);
    expect(f[1]!.state).toBe("failed");
    const c = stepper("sizing", "cancelled");
    expect(c).toHaveLength(4);
    expect(c[3]).toEqual({ label: "⊘ cancelled", state: "cancelled" });
  });
});

describe("cost / budget", () => {
  it("prefers perPodUsd, else daily cap / pods per day", () => {
    expect(podBudget({ dailySpendCapUsd: 50, maxPodsPerDay: 40, perPodUsd: 3 })!.usd).toBe(3);
    const b = podBudget({ dailySpendCapUsd: 50, maxPodsPerDay: 10 })!;
    expect(b.usd).toBe(5);
    expect(b.basis).toContain("daily cap");
  });
  it("null when nothing is usable", () => {
    expect(podBudget({ dailySpendCapUsd: 50, maxPodsPerDay: 0 })).toBeNull();
    expect(podBudget({ dailySpendCapUsd: 0, maxPodsPerDay: 5 })).toBeNull();
  });
  it("ratio is unclamped and 0 without a budget", () => {
    expect(costRatio(1.5, 3)).toBe(0.5);
    expect(costRatio(4, 3)).toBeCloseTo(1.333, 3);
    expect(costRatio(1, null)).toBe(0);
    expect(costRatio(1, 0)).toBe(0);
  });
  it("formats", () => {
    expect(usd1s(18.44)).toBe("+$18.4");
    expect(usd1s(-3)).toBe("−$3.0");
  });
});

describe("clock / durations", () => {
  it("mm:ss, h:mm:ss", () => {
    expect(clock(401)).toBe("06:41");
    expect(clock(3661)).toBe("1:01:01");
    expect(clock(-5)).toBe("00:00");
  });
  const a = { role: "news", status: "running", output: null, startedAt: 1000, finishedAt: null, durationS: null };
  it("running agent ticks, finished uses stored duration", () => {
    expect(agentDurS(a, 6000)).toBe(5);
    expect(agentDurS({ ...a, status: "ok", durationS: 12 }, 6000)).toBe(12);
  });
  it("elapsed: wall clock while live, last finish after", () => {
    expect(elapsedS({ status: "running", startedAt: 0 }, [], 90_000)).toBe(90);
    expect(elapsedS({ status: "done", startedAt: 0 }, [{ ...a, finishedAt: 30_000 }, { ...a, finishedAt: 45_000 }], 999_999)).toBe(45);
    expect(elapsedS({ status: "failed", startedAt: 0 }, [], 999_999)).toBe(0);
  });
});

describe("agents", () => {
  const ag = (role: string, id: number, p?: number, status = "ok") => ({ id, role, status, output: p == null ? null : { probability: p }, startedAt: null, finishedAt: null, durationS: null });
  it("p_pre = mean of finished non-rules non-judge estimates", () => {
    expect(blindMean([ag("rules", 1), ag("source", 2, 0.4), ag("news", 3, 0.6), ag("red_team", 4, 0.9, "failed"), ag("judge", 5, 0.8)])).toBeCloseTo(0.5);
    expect(blindMean([ag("rules", 1)])).toBeNull();
  });
  it("orders built-ins, custom, judge last; marks repeated roles as retries", () => {
    const rows = [ag("judge", 6), ag("custom_x", 5), ag("news", 4), ag("rules", 1), ag("source", 2), ag("source", 3)];
    expect(byRole(rows).map((a) => a.role)).toEqual(["rules", "source", "source", "news", "custom_x", "judge"]);
    expect([...retryIds(rows)]).toEqual([3]);
  });
});

describe("tool-call log autoscroll", () => {
  it("atBottom with tolerance", () => {
    expect(atBottom(680, 320, 1000)).toBe(true);
    expect(atBottom(676, 320, 1000)).toBe(true);
    expect(atBottom(500, 320, 1000)).toBe(false);
  });
  it("at bottom: scroll on new rows, nothing unseen", () => {
    expect(tailStep({ count: 3, unseen: 0 }, 5, true)).toEqual({ count: 5, unseen: 0, scroll: true });
  });
  it("first render scrolls to the newest row", () => {
    expect(tailStep({ count: 0, unseen: 0 }, 40, true).scroll).toBe(true);
  });
  it("scrolled up: no scroll, unseen accumulates", () => {
    const a = tailStep({ count: 3, unseen: 0 }, 5, false);
    expect(a).toEqual({ count: 5, unseen: 2, scroll: false });
    expect(tailStep(a, 9, false)).toEqual({ count: 9, unseen: 6, scroll: false });
  });
  it("no change does not scroll; shrinking resets unseen", () => {
    expect(tailStep({ count: 3, unseen: 0 }, 3, true).scroll).toBe(false);
    expect(tailStep({ count: 5, unseen: 2 }, 2, false)).toEqual({ count: 2, unseen: 0, scroll: false });
  });
});

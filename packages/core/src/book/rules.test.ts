import { describe, expect, it } from "vitest";
import { canStartPod } from "./budget";
import { shouldReResearch } from "./triggers";

const H = 3_600_000;
const D = 24 * H;
const T0 = 1_000_000_000_000;
const th = { mid: 0.5, createdAt: T0, resolvesAt: T0 + 30 * D };

describe("shouldReResearch", () => {
  it("none by default", () => expect(shouldReResearch(th, T0 + H, 0.5, [], false)).toEqual([]));
  it("price move > 8c (exactly 8c does not fire)", () => {
    expect(shouldReResearch(th, T0 + H, 0.59, [], false)).toEqual(["PRICE_MOVE"]);
    expect(shouldReResearch(th, T0 + H, 0.41, [], false)).toEqual(["PRICE_MOVE"]);
    expect(shouldReResearch(th, T0 + H, 0.58, [], false)).toEqual([]);
  });
  it("catalyst passed since thesis; future or older ones don't count", () => {
    expect(shouldReResearch(th, T0 + H, 0.5, [T0 + H / 2], false)).toEqual(["CATALYST_PASSED"]);
    expect(shouldReResearch(th, T0 + H, 0.5, [T0 + 2 * H], false)).toEqual([]);
    expect(shouldReResearch(th, T0 + H, 0.5, [T0 - H], false)).toEqual([]);
  });
  it("new hit", () => expect(shouldReResearch(th, T0 + H, 0.5, [], true)).toEqual(["NEW_HIT"]));
  it("> 72h old AND < 14d left", () => {
    const soon = { ...th, resolvesAt: T0 + 13 * D };
    expect(shouldReResearch(soon, T0 + 73 * H, 0.5, [], false)).toEqual(["STALE"]);
    expect(shouldReResearch(soon, T0 + 72 * H, 0.5, [], false)).toEqual([]);
    expect(shouldReResearch(th, T0 + 73 * H, 0.5, [], false)).toEqual([]); // 27d left
    expect(shouldReResearch({ ...th, resolvesAt: T0 + 17 * D }, T0 + 3 * D + H, 0.5, [], false)).toEqual(["STALE"]); // 13.96d left
  });
  it("several reasons at once", () => {
    expect(shouldReResearch(th, T0 + H, 0.7, [T0 + 1], true)).toEqual(["PRICE_MOVE", "CATALYST_PASSED", "NEW_HIT"]);
  });
});

describe("canStartPod", () => {
  const knobs = { maxPodsPerDay: 10, maxConcurrentSandboxes: 10, dailySpendCapUsd: 20 };
  const st = { podsToday: 0, activeSandboxes: 0, spendTodayUsd: 0 };
  it("ok", () => expect(canStartPod(st, knobs, 5)).toEqual({ ok: true }));
  it("spend cap is a hard stop at >= cap", () => {
    expect(canStartPod({ ...st, spendTodayUsd: 20 }, knobs, 5)).toEqual({ ok: false, reason: "DAILY_SPEND_CAP" });
    expect(canStartPod({ ...st, spendTodayUsd: 19.99 }, knobs, 5).ok).toBe(true);
  });
  it("pods/day", () => {
    expect(canStartPod({ ...st, podsToday: 10 }, knobs, 5)).toEqual({ ok: false, reason: "MAX_PODS_PER_DAY" });
    expect(canStartPod({ ...st, podsToday: 9 }, knobs, 5).ok).toBe(true);
  });
  it("concurrent sandboxes include the pod's own", () => {
    expect(canStartPod({ ...st, activeSandboxes: 6 }, knobs, 5)).toEqual({ ok: false, reason: "MAX_CONCURRENT_SANDBOXES" });
    expect(canStartPod({ ...st, activeSandboxes: 5 }, knobs, 5).ok).toBe(true);
  });
  it("spend reason wins", () => {
    expect(canStartPod({ podsToday: 10, activeSandboxes: 10, spendTodayUsd: 99 }, knobs, 5).reason).toBe("DAILY_SPEND_CAP");
  });
});

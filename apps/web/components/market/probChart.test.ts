import { describe, expect, it } from "vitest";
import {
  ariaSummary, axisFor, cents, cleanPoints, extent, FULL_AXIS, fitAxis, lineStats, linear, mergeLive, nearestIndex, orderLabel,
  stepRange, tagLayout, timeLabel, valueAt, xDomain, xTicks, yesPrice, yLabelClear,
} from "./probChart";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime(); // local time, TZ independent
const pts = (...m: number[]) => m.map((mid, i) => ({ ts: i * 1000, mid }));

describe("fitAxis", () => {
  it("snaps to the smallest step giving <= 6 ticks, whole distinct percents", () => {
    expect(fitAxis(5.2, 6.8)).toEqual({ lo: 2, hi: 10, ticks: [2, 4, 6, 8, 10] });
    expect(fitAxis(6, 6)).toEqual({ lo: 4, hi: 8, ticks: [4, 5, 6, 7, 8] }); // flat line: step 1, centred, no repeats
    expect(fitAxis(30, 70).ticks).toEqual([25, 50, 75]); // steps 1..10 would give > 6 ticks
  });
  it("clamps to 0..100 and never repeats a tick (the Rev 7 6¢ 6¢ 5¢ 5¢ bug)", () => {
    expect(fitAxis(0, 0)).toEqual({ lo: 0, hi: 2, ticks: [0, 1, 2] });
    expect(fitAxis(99.6, 100).hi).toBe(100);
    for (let lo = 0; lo <= 99; lo += 0.7) for (const span of [0, 0.4, 1.3, 4, 9, 23, 41, 58]) {
      const a = fitAxis(lo, Math.min(100, lo + span));
      expect(a.ticks.length).toBeLessThanOrEqual(6);
      expect(new Set(a.ticks).size).toBe(a.ticks.length);
      expect(a.ticks.every(Number.isInteger)).toBe(true);
      expect(a.lo).toBeLessThanOrEqual(lo);
      expect(a.hi).toBeGreaterThanOrEqual(Math.min(100, lo + span));
      expect(a.hi).toBeGreaterThan(a.lo);
    }
  });
});

describe("axisFor", () => {
  it("0–100 mode is 0 25 50 75 100", () => {
    expect(axisFor("full", { min: 5, max: 7 }, false)).toBe(FULL_AXIS);
    expect(FULL_AXIS.ticks).toEqual([0, 25, 50, 75, 100]);
  });
  it("Fit falls back to 0–100 when both lines span more than 60 points, or with no data", () => {
    expect(axisFor("fit", { min: 10, max: 90 }, true)).toBe(FULL_AXIS);
    expect(axisFor("fit", { min: 30, max: 70 }, false).lo).toBe(25);
    expect(axisFor("fit", { min: 40, max: 60 }, true).ticks.length).toBeLessThanOrEqual(6);
    expect(axisFor("fit", null, false)).toBe(FULL_AXIS);
  });
  it("extent covers visible lines (NO = 100 − YES) and extras", () => {
    const p = pts(0.2, 0.3);
    expect(extent(p, true, false)).toEqual({ min: 20, max: 30 });
    expect(extent(p, false, true)).toEqual({ min: 70, max: 80 });
    expect(extent(p, true, true)).toEqual({ min: 20, max: 80 });
    expect(extent(p, true, false, [45])).toEqual({ min: 20, max: 45 });
    expect(extent(p, false, false)).toBeNull();
    expect(extent([], true, true)).toBeNull();
  });
});

describe("data helpers", () => {
  it("cleanPoints drops junk, sorts, keeps the later duplicate", () => {
    const out = cleanPoints([{ ts: 3, mid: 0.3 }, { ts: 1, mid: 0.1 }, { ts: 2, mid: NaN }, { ts: 4, mid: 1.2 }, { ts: 5, mid: null }, { ts: 3, mid: 0.35 }]);
    expect(out).toEqual([{ ts: 1, mid: 0.1 }, { ts: 3, mid: 0.35 }]);
    expect(cleanPoints(null)).toEqual([]);
  });
  it("mergeLive appends at now, never before the last point; ignores a missing live mid", () => {
    const p = pts(0.1, 0.2);
    expect(mergeLive(p, 0.25, 5000).at(-1)).toEqual({ ts: 5000, mid: 0.25 });
    expect(mergeLive(p, 0.25, 500).at(-1)).toEqual({ ts: 1001, mid: 0.25 });
    expect(mergeLive(p, null, 5000)).toBe(p);
    expect(mergeLive(p, Number.NaN, 5000)).toBe(p);
    expect(mergeLive([], 0.4, 7).length).toBe(1);
    expect(p.length).toBe(2); // input untouched
  });
  it("xDomain: window ending at the last point, clamped to the first point; ALL spans everything", () => {
    const day = 86_400_000, p = [{ ts: 0, mid: 0.1 }, { ts: 40 * day, mid: 0.2 }];
    expect(xDomain(p, "1d")).toEqual([39 * day, 40 * day]);
    expect(xDomain(p, "1m")).toEqual([10 * day, 40 * day]);
    expect(xDomain(p, "all")).toEqual([0, 40 * day]);
    expect(xDomain([{ ts: 5, mid: 0.1 }, { ts: 9, mid: 0.2 }], "1w")).toEqual([5, 9]); // short history is not stretched
  });
  it("nearestIndex / valueAt", () => {
    const p = pts(0.1, 0.2, 0.4); // ts 0 1000 2000
    expect(nearestIndex(p, -50)).toBe(0);
    expect(nearestIndex(p, 400)).toBe(0);
    expect(nearestIndex(p, 600)).toBe(1);
    expect(nearestIndex(p, 1700)).toBe(2);
    expect(nearestIndex(p, 9e9)).toBe(2);
    expect(nearestIndex([], 1)).toBe(-1);
    expect(valueAt(p, 500)).toBeCloseTo(0.15);
    expect(valueAt(p, 1500)).toBeCloseTo(0.3);
    expect(valueAt(p, -1)).toBe(0.1);
    expect(valueAt(p, 1e9)).toBe(0.4);
    expect(valueAt([], 1)).toBeNull();
  });
  it("stepRange clamps at both ends", () => {
    expect(stepRange("1m", 1)).toBe("all");
    expect(stepRange("all", 1)).toBe("all");
    expect(stepRange("1d", -1)).toBe("1d");
    expect(stepRange("1w", -1)).toBe("1d");
  });
  it("linear maps the domain, flat domain -> start", () => {
    const f = linear(10, 20, 0, 100);
    expect([f(10), f(15), f(20)]).toEqual([0, 50, 100]);
    expect(linear(5, 5, 3, 9)(5)).toBe(3);
    expect(linear(0, 100, 200, 0)(25)).toBe(150);
  });
});

describe("cents", () => {
  it("follows the tick", () => {
    expect(cents(0.06)).toBe("6¢");
    expect(cents(0.94)).toBe("94¢");
    expect(cents(0.412, 0.001)).toBe("41.2¢");
    expect(cents(1 - 0.06)).toBe("94¢");
  });
});

describe("xTicks", () => {
  const W = 600;
  const gaps = (t: { x: number }[]) => t.slice(1).map((x, i) => x.x - t[i]!.x);
  it("1D: every 4h as HH:mm, first and last present, >= 56px apart", () => {
    const t0 = at(2026, 10, 19, 14, 5), t1 = at(2026, 10, 20, 14, 5);
    const t = xTicks(t0, t1, "1d", W);
    expect(t[0]!.ts).toBe(t0);
    expect(t.at(-1)!.ts).toBe(t1);
    expect(t.map((x) => x.label).slice(1, -1)).toEqual(["20:00", "00:00", "04:00", "08:00"]); // 16:00 and 12:00 are < 56px from the end labels
    expect(Math.min(...gaps(t))).toBeGreaterThanOrEqual(56);
  });
  it("1W: one per day `Mon 20`", () => {
    const t = xTicks(at(2026, 10, 13, 12), at(2026, 10, 20, 12), "1w", W);
    expect(t.slice(1, -1).map((x) => x.label)).toEqual(["Thu 15", "Fri 16", "Sat 17", "Sun 18", "Mon 19"]); // 14th and 20th are < 56px from the end labels
    expect(Math.min(...gaps(t))).toBeGreaterThanOrEqual(56);
  });
  it("1M: day-of-month multiples of 5, `Oct 5`", () => {
    const t = xTicks(at(2026, 9, 20), at(2026, 10, 20), "1m", W);
    expect(t.some((x) => x.label === "Oct 5")).toBe(true);
    expect(t.some((x) => x.label === "Oct 7")).toBe(false);
  });
  it("ALL: monthly `Jan ’26`, weekly `Oct 5` under 90 days", () => {
    const m = xTicks(at(2025, 11, 3), at(2026, 6, 10), "all", 900);
    expect(m.some((x) => x.label === "Jan ’26")).toBe(true);
    const w = xTicks(at(2026, 8, 20), at(2026, 10, 20), "all", W);
    expect(w.some((x) => x.label === "Oct 5")).toBe(true); // Oct 5 2026 is a Monday
    expect(w.some((x) => x.label === "Oct 6")).toBe(false);
  });
  it("no label twice: a day tick on the last point's day is dropped (1M, market 3.5 days old)", () => {
    const t = xTicks(at(2026, 10, 17, 3), at(2026, 10, 20, 22, 43), "1m", W);
    const labels = t.map((x) => x.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.at(-1)).toBe("Oct 20");
  });
  it("finer step when the span is too short for the range's own (2h of snapshots on 1D)", () => {
    const t = xTicks(at(2026, 10, 20, 12, 3), at(2026, 10, 20, 14, 7), "1d", W);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.every((x) => /^\d\d:\d\d$/.test(x.label))).toBe(true);
  });
  it("labels stay inside the plot and degenerate input gives none", () => {
    const t = xTicks(at(2026, 10, 19), at(2026, 10, 20), "1d", 300);
    expect(t.every((x) => x.x >= 0 && x.x <= 300)).toBe(true);
    expect(t.at(-1)!.x + (t.at(-1)!.label.length * 6.6) / 2).toBeLessThanOrEqual(300 - 6); // the last label stays clear of the y-axis labels beyond the plot
    expect(xTicks(5, 5, "1d", 300)).toEqual([]);
    expect(xTicks(0, 5, "1d", 0)).toEqual([]);
  });
});

describe("timeLabel", () => {
  const ts = at(2026, 10, 20, 14, 5);
  it("per range", () => {
    expect(timeLabel(ts, "1d")).toBe("Oct 20 · 14:05");
    expect(timeLabel(ts, "1w")).toBe("Tue, Oct 20 · 14:05");
    expect(timeLabel(ts, "1m")).toBe("Oct 20 · 14:05");
    expect(timeLabel(ts, "all", 200 * 86_400_000)).toBe("Oct 20, 2026");
    expect(timeLabel(ts, "all", 30 * 86_400_000)).toBe("Oct 20 · 14:05");
  });
});

describe("overlays", () => {
  it("tagLayout: overlapping tags, the non-preferred yields", () => {
    expect(tagLayout(100, 105, "YES")).toEqual({ yes: true, no: false });
    expect(tagLayout(100, 105, "NO")).toEqual({ yes: false, no: true });
    expect(tagLayout(100, 140, "NO")).toEqual({ yes: true, no: true });
    expect(tagLayout(100, null, "NO")).toEqual({ yes: true, no: false });
    expect(tagLayout(null, null, "YES")).toEqual({ yes: false, no: false });
  });
  it("yLabelClear: a y label under a price tag yields, others stay", () => {
    expect(yLabelClear(10, [14, null])).toBe(false);
    expect(yLabelClear(10, [30, 200])).toBe(true);
    expect(yLabelClear(10, [null, null])).toBe(true);
  });
  it("own orders live in YES space and read in the chart's outcome", () => {
    expect(yesPrice({ price: 0.41, outcome: "YES" })).toBe(0.41);
    expect(yesPrice({ price: 0.41, outcome: "NO" })).toBeCloseTo(0.59);
    expect(orderLabel({ price: 0.412, side: "BUY", outcome: "YES", shares: 500 }, 0.001)).toBe("your bid 41.2¢ · 500");
    expect(orderLabel({ price: 0.42, side: "SELL", outcome: "YES" })).toBe("your ask 42¢");
    expect(orderLabel({ price: 0.4, side: "BUY", outcome: "NO", shares: 1200 }, 0.01, "YES")).toBe("your NO bid 40¢ · 1,200");
    expect(orderLabel({ price: 0.4, side: "BUY", outcome: "NO" }, 0.01, "NO")).toBe("your bid 40¢");
  });
});

describe("a11y", () => {
  it("aria summary matches the spec wording", () => {
    expect(ariaSummary("1m", 0.06, 312)).toBe("YES and NO price history, 1 month, YES 6¢, NO 94¢, 312 points");
    expect(ariaSummary("1d", null, 1)).toBe("YES and NO price history, 1 day, 1 point");
  });
  it("lineStats mirrors NO", () => {
    const s = lineStats(pts(0.1, 0.3, 0.2))!;
    expect(s.YES).toEqual({ first: 0.1, last: 0.2, min: 0.1, max: 0.3 });
    expect(s.NO.first).toBeCloseTo(0.9);
    expect(s.NO.min).toBeCloseTo(0.7);
    expect(s.NO.max).toBeCloseTo(0.9);
    expect(lineStats([])).toBeNull();
  });
});

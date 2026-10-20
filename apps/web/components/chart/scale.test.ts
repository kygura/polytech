import { describe, expect, it } from "vitest";
import { change, linePath, nearest, timeLabel, withLive, xTicks, yDomain, yTicks } from "./scale";

const H = 3_600_000, D = 24 * H;

describe("yDomain", () => {
  it("pads the range and stays inside 0..1", () => {
    const [lo, hi] = yDomain([0.4, 0.6]);
    expect(lo).toBeLessThan(0.4);
    expect(hi).toBeGreaterThan(0.6);
    expect(yDomain([0.001, 0.999])).toEqual([0, 1]);
  });
  it("never zooms tighter than 4c", () => {
    const [lo, hi] = yDomain([0.5, 0.5]);
    expect(hi - lo).toBeCloseTo(0.04);
  });
  it("shifts instead of clipping at the edges", () => {
    const [lo, hi] = yDomain([0.99, 0.995]);
    expect(hi).toBe(1);
    expect(hi - lo).toBeGreaterThanOrEqual(0.04 - 1e-9);
  });
});

describe("ticks", () => {
  it("price ticks are round and inside the domain", () => {
    const t = yTicks(0.31, 0.58);
    expect(t).toEqual([0.35, 0.4, 0.45, 0.5, 0.55]);
    expect(yTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
  it("time ticks stay inside the span and step evenly", () => {
    const t0 = Date.UTC(2026, 9, 1, 3, 17), t = xTicks(t0, t0 + 7 * D, 5);
    expect(t.length).toBeGreaterThan(1);
    expect(t.length).toBeLessThanOrEqual(5);
    expect(t.every((x) => x >= t0 && x <= t0 + 7 * D)).toBe(true);
    const steps = new Set(t.slice(1).map((x, i) => x - t[i]!));
    expect(steps.size).toBe(1);
    expect(xTicks(t0, t0)).toEqual([]);
  });
  it("labels clock time under two days, dates above", () => {
    const t = new Date(2026, 9, 12, 14, 5).getTime();
    expect(timeLabel(t, H)).toBe("14:05");
    expect(timeLabel(t, 30 * D)).toBe("Oct 12");
    expect(timeLabel(t, 500 * D)).toBe("Oct '26");
  });
});

describe("series", () => {
  const pts = [{ ts: 3000, p: 0.5 }, { ts: 1000, p: 0.4 }, { ts: 2000, p: 0.45 }];
  it("sorts and appends the live price after the last point", () => {
    const s = withLive(pts, 0.55, 2500);
    expect(s.map((x) => x.ts)).toEqual([1000, 2000, 3000, 3001]);
    expect(s.at(-1)!.p).toBe(0.55);
    expect(withLive(pts, null, 0)).toHaveLength(3);
  });
  it("nearest picks the closest point by time", () => {
    const s = withLive(pts, null, 0);
    expect(nearest(s, 0)).toBe(0);
    expect(nearest(s, 1600)).toBe(1);
    expect(nearest(s, 9e9)).toBe(2);
    expect(nearest([], 5)).toBe(-1);
  });
  it("change is last minus first", () => {
    expect(change(withLive(pts, null, 0))).toBeCloseTo(0.1);
    expect(change([{ ts: 1, p: 0.3 }])).toBeNull();
  });
  it("draws a step line", () => {
    expect(linePath([{ ts: 0, p: 0 }, { ts: 1, p: 1 }], (t) => t * 10, (p) => p * 10)).toBe("M0.0,0.0H10.0V10.0");
  });
});

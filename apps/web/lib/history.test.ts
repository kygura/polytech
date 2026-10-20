import { describe, expect, it, vi } from "vitest";
import { downsample, loadHistory, makeCache, MAX_POINTS, parseRange, RANGE_QUERY, RANGES, toPoints, type HistoryDeps } from "./history";

describe("range mapping", () => {
  it("accepts only the four ranges", () => {
    expect(RANGES.map(parseRange)).toEqual(["1d", "1w", "1m", "all"]);
    expect(["1y", "", "1D", null, undefined, 5].map(parseRange)).toEqual([null, null, null, null, null, null]);
  });
  it("maps to Polymarket interval + fidelity and a snapshot window", () => {
    expect(RANGE_QUERY["1d"]).toMatchObject({ interval: "1d", fidelity: 5 });
    expect(RANGE_QUERY["1w"]).toMatchObject({ interval: "1w", fidelity: 60 });
    expect(RANGE_QUERY["1m"].interval).toBe("1m");
    expect(RANGE_QUERY.all).toMatchObject({ interval: "max", fidelity: 1440, windowMs: null });
  });
  it("every range at its fidelity stays near the point budget", () => {
    // 1d / 5 min = 288, 1w / 60 min = 168, 1m / 180 min = 240
    expect([24 * 60 / 5, 7 * 24, (30 * 24 * 60) / 180].every((n) => n <= MAX_POINTS)).toBe(true);
  });
});

describe("downsample", () => {
  const series = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: i, mid: i }));
  it("returns a copy when under the cap", () => {
    const s = series(10);
    const out = downsample(s, 500);
    expect(out).toEqual(s);
    expect(out).not.toBe(s);
  });
  it("caps at max, keeps first and last, stays ascending and unique", () => {
    const out = downsample(series(5000), 500);
    expect(out).toHaveLength(500);
    expect(out[0]!.ts).toBe(0);
    expect(out.at(-1)!.ts).toBe(4999);
    expect(out.every((p, i) => i === 0 || p.ts > out[i - 1]!.ts)).toBe(true);
  });
  it("default cap is 500; exactly-at-cap input is untouched", () => {
    expect(downsample(series(501))).toHaveLength(MAX_POINTS);
    expect(downsample(series(500))).toHaveLength(500);
  });
});

describe("toPoints", () => {
  it("seconds -> ms, sorted, non-finite dropped", () => {
    expect(toPoints([{ t: 20, p: 0.5 }, { t: 10, p: 0.4 }, { t: NaN, p: 0.1 }, { t: 30, p: Infinity }])).toEqual([{ ts: 10_000, mid: 0.4 }, { ts: 20_000, mid: 0.5 }]);
  });
});

describe("loadHistory", () => {
  const deps = (o: Partial<HistoryDeps> = {}): HistoryDeps => ({
    tokenId: "tok", now: 10_000_000_000,
    pm: { pricesHistory: vi.fn(async () => [{ t: 1, p: 0.4 }, { t: 2, p: 0.5 }]) },
    snapshots: vi.fn(async () => [{ ts: 5, mid: 0.3 }]),
    ...o,
  });
  it("asks Polymarket for the mapped interval and fidelity", async () => {
    const d = deps();
    const r = await loadHistory("1w", d);
    expect(d.pm.pricesHistory).toHaveBeenCalledWith({ token: "tok", interval: "1w", fidelity: 60 });
    expect(r).toEqual({ range: "1w", source: "polymarket", points: [{ ts: 1000, mid: 0.4 }, { ts: 2000, mid: 0.5 }] });
    expect(d.snapshots).not.toHaveBeenCalled();
  });
  it("downsamples a long Polymarket answer", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ t: i, p: 0.5 }));
    const r = await loadHistory("all", deps({ pm: { pricesHistory: async () => big } }));
    expect(r.points).toHaveLength(MAX_POINTS);
  });
  it("falls back to own snapshots (windowed) when Polymarket throws or is empty", async () => {
    for (const pricesHistory of [async () => { throw new Error("502"); }, async () => []]) {
      const d = deps({ pm: { pricesHistory } });
      const r = await loadHistory("1d", d);
      expect(r).toEqual({ range: "1d", source: "snapshots", points: [{ ts: 5, mid: 0.3 }] });
      expect(d.snapshots).toHaveBeenCalledWith(10_000_000_000 - 24 * 3_600_000);
    }
  });
  it("ALL on a young market asks again hourly when daily buckets are too few", async () => {
    const pricesHistory = vi.fn(async ({ fidelity }: { fidelity?: number }) => fidelity === 60 ? Array.from({ length: 72 }, (_, i) => ({ t: i, p: 0.5 })) : [{ t: 1, p: 0.4 }, { t: 2, p: 0.5 }]);
    const r = await loadHistory("all", deps({ pm: { pricesHistory } }));
    expect(pricesHistory).toHaveBeenLastCalledWith({ token: "tok", interval: "max", fidelity: 60 });
    expect(r.points).toHaveLength(72);
  });
  it("no token: snapshots only; ALL reads everything", async () => {
    const d = deps({ tokenId: null });
    await loadHistory("all", d);
    expect(d.pm.pricesHistory).not.toHaveBeenCalled();
    expect(d.snapshots).toHaveBeenCalledWith(0);
  });
});

describe("makeCache", () => {
  it("dedupes concurrent loads and serves the memo until the TTL", async () => {
    let t = 0;
    const c = makeCache<number>(60_000, () => t);
    const load = vi.fn(async () => 7);
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b]).toEqual([7, 7]);
    t = 59_999;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 60_000;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("keys are independent", async () => {
    const c = makeCache<string>(1000, () => 0);
    expect([await c.get("a", async () => "A"), await c.get("b", async () => "B")]).toEqual(["A", "B"]);
  });
  it("a rejected load is shared while in flight but not remembered", async () => {
    const c = makeCache<number>(60_000, () => 0);
    const bad = vi.fn(async () => { throw new Error("x"); });
    const r = await Promise.allSettled([c.get("k", bad), c.get("k", bad)]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(bad).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(await c.get("k", async () => 1)).toBe(1);
  });
  it("bounds its size", async () => {
    const c = makeCache<number>(60_000, () => 0, 3);
    for (const k of "abcde") await c.get(k, async () => 1);
    expect(c.size).toBeLessThanOrEqual(3);
  });
});

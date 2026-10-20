import { describe, expect, it } from "vitest";
import { drift, extremize, fitExtremize, liquidityBand, paperPnl, rBucket, summarize, type JournalRow } from "./journal";

const row = (o: Partial<JournalRow> = {}): JournalRow => ({
  thesisId: "t", conditionId: "c", category: "econ", model: "m1", pHat: 0.7, pPre: 0.65, midAt: 0.5, liquidityAt: 10_000, r: 0.6,
  side: "YES", stake: 100, result: "YES", resolvedAt: "2026-01-02T00:00:00Z",
  brierModel: 0.09, brierMarket: 0.25, brierPre: 0.1225, logLoss: -Math.log(0.7), drift24h: null, drift7d: null, paperPnl: 10, ...o,
});

describe("drift / paperPnl", () => {
  it("drift toward p", () => {
    expect(drift(0.4, 0.45, 0.6)).toBeCloseTo(0.05, 12);
    expect(drift(0.4, 0.35, 0.6)).toBeCloseTo(-0.05, 12);
    expect(drift(0.6, 0.55, 0.4)).toBeCloseTo(0.05, 12);
    expect(drift(0.5, 0.6, 0.5)).toBe(0);
  });
  it("paperPnl", () => {
    expect(paperPnl({ side: "YES", stake: 100, aEff: 0.4, outcome: 1 })).toBeCloseTo(150, 9);
    expect(paperPnl({ side: "YES", stake: 100, aEff: 0.4, outcome: 0 })).toBeCloseTo(-100, 9);
    expect(paperPnl({ side: "NO", stake: 100, aEff: 0.6, outcome: 0 })).toBeCloseTo(100 / 0.6 - 100, 9);
    expect(paperPnl({ side: "NO", stake: 100, aEff: 0.6, outcome: 1 })).toBeCloseTo(-100, 9);
    expect(paperPnl({ side: "YES", stake: 0, aEff: 0.5, outcome: 1 })).toBe(0);
    expect(paperPnl({ side: "YES", stake: 10, aEff: 0, outcome: 1 })).toBe(0);
  });
});

describe("extremize / bands", () => {
  it("scales log-odds, k=1 is identity, clamps", () => {
    expect(extremize(0.7, 1)).toBeCloseTo(0.7, 12);
    expect(extremize(0.7, 2)).toBeGreaterThan(0.8);
    expect(extremize(0.7, 0.5)).toBeLessThan(0.7);
    expect(extremize(0.5, 3)).toBeCloseTo(0.5, 12);
    expect(Number.isFinite(extremize(0, 3))).toBe(true);
    expect(extremize(1, 3)).toBeLessThanOrEqual(1);
  });
  it("liquidityBand / rBucket", () => {
    expect([1999, 2000, 10_000, 50_000, null].map(liquidityBand)).toEqual(["<2k", "2k–10k", "10k–50k", "50k+", "unknown"]);
    expect([0, 0.25, 0.6, 0.99, 1, null].map(rBucket)).toEqual(["0–.25", ".25–.5", ".5–.75", ".75–1", ".75–1", "unknown"]);
  });
});

describe("summarize", () => {
  it("empty", () => {
    expect(summarize([])).toMatchObject({ n: 0, resolved: 0, brierModel: null, skillVsMarket: null, paperPnl: 0, hitRate: null, pnlSeries: [] });
  });
  it("KPIs: unresolved only counted in n", () => {
    const s = summarize([row({ result: null, resolvedAt: null, paperPnl: null }), row()]);
    expect(s).toMatchObject({ n: 2, resolved: 1, paperPnl: 10, hitRate: 1 });
    expect(s.brierModel).toBeCloseTo(0.09, 12);
    expect(s.brierMarket).toBeCloseTo(0.25, 12);
    expect(s.brierPre).toBeCloseTo(0.1225, 12);
    expect(s.skillVsMarket).toBeCloseTo(0.16, 12);
  });
  it("skill uses only rows with a market brier; hit rate over staked resolved", () => {
    const s = summarize([row({ brierMarket: null, brierModel: 0.0001 }), row({ paperPnl: -20, result: "NO" }), row({ stake: 0, paperPnl: 0 })]);
    expect(s.skillVsMarket).toBeCloseTo(0.16, 12);
    expect(s.hitRate).toBe(0.5);
  });
  it("cumulative P&L ordered by resolved_at", () => {
    const s = summarize([
      row({ resolvedAt: "2026-01-03T00:00:00Z", paperPnl: -5 }),
      row({ resolvedAt: new Date("2026-01-01T00:00:00Z"), paperPnl: 10 }),
      row({ resolvedAt: "2026-01-02T00:00:00Z", paperPnl: 3 }),
    ]);
    expect(s.pnlSeries.map((p) => p.cum)).toEqual([10, 13, 8]);
    expect(s.pnlSeries[0]!.t).toBe("2026-01-01T00:00:00.000Z");
  });
  it("breakdowns", () => {
    const s = summarize([
      row({ liquidityAt: 1000 }),
      row({ liquidityAt: 20_000, paperPnl: 5 }),
      row({ category: null, liquidityAt: null, model: "m2", r: 0.1, result: "NO", brierModel: 0.49, brierMarket: 0.25, paperPnl: null }),
      row({ category: null, result: null, paperPnl: null }),
    ]);
    const cat = Object.fromEntries(s.byCategory.map((r) => [r.key, r]));
    expect(cat.econ).toMatchObject({ n: 2, paperPnl: 15 });
    expect(cat.unknown!.n).toBe(1);
    expect(cat.unknown!.brierModel).toBeCloseTo(0.49, 12);
    expect(cat.unknown!.paperPnl).toBeNull();
    expect(s.byLiquidity.map((r) => r.key).sort()).toEqual(["10k–50k", "<2k", "unknown"].sort());
    expect(s.byModel.map((r) => r.key).sort()).toEqual(["m1", "m2"]);
    expect(s.byR.map((r) => r.key).sort()).toEqual([".5–.75", "0–.25"]);
  });
});

describe("fitExtremize", () => {
  const rows = (n: number, p: number, yes: (i: number) => boolean) =>
    Array.from({ length: n }, (_, i) => ({ pHat: p, result: (yes(i) ? "YES" : "NO") as "YES" | "NO" }));
  it("null below 30 resolved (unresolved ignored)", () => {
    expect(fitExtremize(rows(29, 0.65, () => true))).toBeNull();
    expect(fitExtremize([...rows(29, 0.65, () => true), { pHat: 0.5, result: null }])).toBeNull();
  });
  it("underconfident -> >1.5", () => {
    expect(fitExtremize([...rows(15, 0.65, () => true), ...Array.from({ length: 15 }, () => ({ pHat: 0.35, result: "NO" as const }))])).toBeGreaterThan(1.5);
  });
  it("overconfident -> <0.7", () => {
    expect(fitExtremize(rows(40, 0.9, (i) => i % 2 === 0))).toBeLessThan(0.7);
  });
  it("calibrated ~1 and within grid", () => {
    const k = fitExtremize(rows(50, 0.8, (i) => i % 5 !== 0))!;
    expect(k).toBeGreaterThanOrEqual(0.9);
    expect(k).toBeLessThanOrEqual(1.1);
  });
});

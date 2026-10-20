import type { JournalRow } from "@pm/core";
import { describe, expect, it } from "vitest";
import { breakdownRows, driftHistogram, liquidityBand, nearestIndex, parseMinN, rBucket, rollingBrier } from "./journal";

const row = (o: Partial<JournalRow> = {}): JournalRow => ({
  thesisId: "t", conditionId: "c", category: "sports", model: "m1", pHat: 0.6, pPre: null, midAt: 0.5, liquidityAt: 10_000, r: 0.4, side: "YES", stake: 10,
  result: "YES", resolvedAt: "2026-10-01T00:00:00Z", brierModel: 0.2, brierMarket: 0.25, brierPre: null, logLoss: 0.5, drift24h: null, drift7d: null, paperPnl: 1, ...o,
});
const at = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString();

describe("rollingBrier", () => {
  it("needs a full window; one point per resolved row from the 20th, oldest first, means over the last 20", () => {
    const rs = Array.from({ length: 25 }, (_, i) => row({ thesisId: `t${i}`, resolvedAt: at(24 - i), brierModel: i, brierMarket: i + 1 })); // shuffled order in: newest first
    expect(rollingBrier(rs.slice(0, 19))).toEqual([]);
    const out = rollingBrier(rs);
    expect(out).toHaveLength(6);
    // oldest-first order: brierModel runs 24, 23, ... 0; first window = 24..5 -> mean 14.5
    expect(out[0]!.model).toBeCloseTo(14.5);
    expect(out[0]!.market).toBeCloseTo(15.5);
    expect(out[5]!.model).toBeCloseTo(9.5);
    expect(out[0]!.pre).toBeNull();
  });
  it("skips unresolved rows and rows missing model or market Brier; pre averages what exists", () => {
    const rs = [...Array.from({ length: 20 }, (_, i) => row({ resolvedAt: at(i), brierPre: i % 2 ? 0.3 : null })), row({ result: null }), row({ brierMarket: null })];
    const out = rollingBrier(rs);
    expect(out).toHaveLength(1);
    expect(out[0]!.pre).toBeCloseTo(0.3);
  });
});

describe("driftHistogram", () => {
  it("1-cent bins -10..+10, clamped at the ends; means in cents over the non-null values", () => {
    const h = driftHistogram([
      { drift24h: 0.006, drift7d: 0.014 }, // +0.6c -> bin [0,1); +1.4c -> [1,2)
      { drift24h: -0.0001, drift7d: 0.5 }, // -0.01c -> [-1,0); +50c clamps to the last bin
      { drift24h: -0.2, drift7d: null }, // -20c clamps to the first bin
    ]);
    expect(h.bins).toHaveLength(20);
    expect(h.bins[0]).toEqual({ lo: -10, hi: -9, n24: 1, n7: 0 });
    expect(h.bins[9]!.n24).toBe(1); // [-1,0)
    expect(h.bins[10]!.n24).toBe(1); // [0,1)
    expect(h.bins[11]!.n7).toBe(1); // [1,2)
    expect(h.bins[19]!.n7).toBe(1);
    expect(h.n24).toBe(3);
    expect(h.n7).toBe(2);
    expect(h.mean24).toBeCloseTo((0.6 - 0.01 - 20) / 3, 5);
    expect(h.mean7).toBeCloseTo((1.4 + 50) / 2, 5);
  });
  it("empty -> null means", () => {
    expect(driftHistogram([])).toMatchObject({ mean24: null, mean7: null, n24: 0 });
  });
});

describe("bands and buckets", () => {
  it("design bands", () => {
    expect([4999, 5000, 24_999, 25_000, 99_999, 100_000, null].map(liquidityBand)).toEqual(["<$5k", "$5–25k", "$5–25k", "$25–100k", "$25–100k", ">$100k", "unknown"]);
    expect([0.29, 0.3, 0.6, 0.61, null].map(rBucket)).toEqual(["<0.3", "0.3–0.6", "0.3–0.6", ">0.6", "unknown"]);
  });
});

describe("breakdownRows", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row({ thesisId: `a${i}`, category: "sports", paperPnl: i < 4 ? 5 : -5, brierModel: 0.1, brierMarket: 0.2, drift7d: 0.02 })),
    ...Array.from({ length: 2 }, (_, i) => row({ thesisId: `b${i}`, category: "crypto", paperPnl: 100 })),
    row({ thesisId: "u", category: "politics", result: null }),
  ];
  it("groups resolved rows; n, mean Brier, P&L, hit rate over staked, gate, drift in cents", () => {
    const [sports] = breakdownRows(rows, "category", 5);
    expect(sports).toMatchObject({ key: "sports", n: 6, gate: "6/30", low: false, pnl: 10 });
    expect(sports!.brier).toBeCloseTo(0.1);
    expect(sports!.market).toBeCloseTo(0.2);
    expect(sports!.hit).toBeCloseTo(4 / 6);
    expect(sports!.drift7).toBeCloseTo(2);
  });
  it("groups under min n stay listed but are flagged and sorted last", () => {
    const out = breakdownRows(rows, "category", 5);
    expect(out.map((r) => [r.key, r.low])).toEqual([["sports", false], ["crypto", true]]); // unresolved-only `politics` has no group
    expect(breakdownRows(rows, "category", 7).every((r) => r.low)).toBe(true);
    expect(breakdownRows(rows, "category", 0).every((r) => !r.low)).toBe(true);
  });
  it("liquidity and R groups come in band order, not by n; low still last", () => {
    const rs = [row({ liquidityAt: 200_000 }), row({ liquidityAt: 200_000 }), row({ liquidityAt: 1000 }), row({ liquidityAt: null })];
    expect(breakdownRows(rs, "liquidity", 1).map((r) => r.key)).toEqual(["<$5k", ">$100k", "unknown"]);
    expect(breakdownRows(rs, "liquidity", 2).map((r) => r.key)).toEqual([">$100k", "<$5k", "unknown"]);
  });
  it("no-stake rows give hit null", () => {
    expect(breakdownRows([row({ stake: null }), row({ stake: 0 })], "model", 1)[0]!.hit).toBeNull();
  });
});

describe("small helpers", () => {
  it("parseMinN", () => {
    expect([undefined, "", "abc", "-1", "0", "12", "5000"].map(parseMinN)).toEqual([5, 5, 5, 5, 0, 12, 999]);
  });
  it("nearestIndex", () => {
    expect(nearestIndex([], 3)).toBe(-1);
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 99)).toBe(2);
  });
});

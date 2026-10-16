import { describe, expect, it } from "vitest";
import { sizeTrade, type SizeInput } from "./sizing";
import { DEFAULT_SETTINGS } from "./types";

const S = DEFAULT_SETTINGS; // B 1000, kelly .25, cap .05, minEdge .02, rAnnCap 5
const base: SizeInput = {
  bids: [{ price: 0.38, size: 100 }],
  asks: [{ price: 0.4, size: 100 }, { price: 0.5, size: 500 }],
  pMid: 0.39, pHat: 0.6, c: 0.5, daysLeft: 365, feeRate: 0.04,
  crowdC: 0, crowdSide: null, settings: S,
};

describe("sizeTrade YES", () => {
  // pPost .495; k0 = .40 + .04*.4*.6 = .4096; e = .0854; f* = .0854/.5904
  it("hand-computed row", () => {
    const r = sizeTrade(base)!;
    expect(r.side).toBe("YES");
    expect(r.pPost).toBeCloseTo(0.495, 12);
    expect(r.k).toBeCloseTo(0.4096, 12);
    expect(r.e).toBeCloseTo(0.0854, 12);
    expect(r.edgeC).toBeCloseTo(8.54, 9);
    expect(r.r).toBeCloseTo(0.0854 / 0.4096, 12);
    expect(r.payoff).toBeCloseTo(0.5904 / 0.4096, 12);
    expect(r.rAnn).toBeCloseTo(0.0854 / 0.4096, 12); // d=365 -> r_ann = r
    expect(r.sizeUsd).toBeCloseTo((0.0854 / 0.5904) * 250, 9); // quarter-Kelly of $1000, < $50 cap, < $40 L1 depth
    expect(r.shares).toBeCloseTo(r.sizeUsd / 0.4, 9);
    expect(r.expectedProfit).toBeCloseTo(r.shares * 0.0854, 9);
    expect(r.rank).toBeCloseTo((0.0854 * r.sizeUsd) / 365, 12);
  });
  it("caps r_ann at 500% for display", () => {
    expect(sizeTrade({ ...base, daysLeft: 30 })!.rAnn).toBe(5); // raw ~ 9.0
  });
  it("0.05*B cap binds with a bigger Kelly", () => {
    expect(sizeTrade({ ...base, pHat: 0.9, settings: { ...S, bankroll: 1000 } })!.sizeUsd).toBeCloseTo(50, 9);
  });
  it("e>=0.02 limit binds when the book is thin above the top level", () => {
    const r = sizeTrade({
      ...base, asks: [{ price: 0.4, size: 100 }, { price: 0.5, size: 10000 }],
      settings: { ...S, bankroll: 100000 },
    })!;
    // solve v+.04v(1-v)=.475 -> v=.46504; S=9.3008/.06992
    expect(r.e).toBeCloseTo(0.02, 5);
    expect(r.sizeUsd).toBeGreaterThan(132);
    expect(r.sizeUsd).toBeLessThan(134);
  });
  it("crowd bonus applies only when trading against the crowd", () => {
    const against = sizeTrade({ ...base, crowdC: 0.5, crowdSide: "NO" })!;
    const with_ = sizeTrade({ ...base, crowdC: 0.5, crowdSide: "YES" })!;
    expect(against.rank).toBeCloseTo(with_.rank * 1.1, 12);
  });
  it("size 0 and rank 0 when edge is below minimum", () => {
    const r = sizeTrade({ ...base, pHat: 0.4, pMid: 0.4 })!; // pPost .4 < k
    expect(r.sizeUsd).toBe(0);
    expect(r.rank).toBe(0);
    expect(r.expectedProfit).toBe(0);
    expect(r.e).toBeLessThan(0);
  });
});

describe("sizeTrade NO", () => {
  const book = {
    ...base, bids: [{ price: 0.6, size: 100 }], asks: [{ price: 0.62, size: 100 }],
    pMid: 0.61, pHat: 0.3,
  };
  it("mirrors the book and picks the side with higher edge", () => {
    const r = sizeTrade(book)!;
    expect(r.side).toBe("NO");
    expect(r.pHat).toBeCloseTo(0.7, 12);
    expect(r.pMid).toBeCloseTo(0.39, 12);
    expect(r.pPost).toBeCloseTo(0.545, 12);
    expect(r.k).toBeCloseTo(0.4096, 12); // NO ask = 1 - .60
  });
});

describe("sizeTrade edges", () => {
  it("dust size (< $1) is zeroed", () => {
    expect(sizeTrade({ ...base, settings: { ...S, bankroll: 10 } })!.sizeUsd).toBe(0);
  });
  it("null when d <= 0 or no asks on either side", () => {
    expect(sizeTrade({ ...base, daysLeft: 0 })).toBeNull();
    expect(sizeTrade({ ...base, bids: [], asks: [] })).toBeNull();
  });
  it("one-sided book still sizes the available side", () => {
    expect(sizeTrade({ ...base, bids: [] })!.side).toBe("YES");
  });
  it("near-certain price: no division blowup", () => {
    const r = sizeTrade({ ...base, asks: [{ price: 0.999, size: 1000 }], bids: [], pHat: 0.9999, pMid: 0.999 })!;
    expect(Number.isFinite(r.payoff)).toBe(true);
    expect(r.sizeUsd).toBe(0);
  });
  it("rejects out-of-range probabilities", () => {
    expect(() => sizeTrade({ ...base, pHat: 1.2 })).toThrow(RangeError);
    expect(() => sizeTrade({ ...base, c: -0.1 })).toThrow(RangeError);
  });
});

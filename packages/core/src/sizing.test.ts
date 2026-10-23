import { describe, expect, it } from "vitest";
import { allInPrice, exitFactor, extremizeP, needEdge, sizeTrade, type SizeInput } from "./sizing";
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
    expect(r.rank).toBeCloseTo((0.0854 * r.sizeUsd) / 365, 12); // exit depth $38 > stake: exitFactor 1
    expect(r.exitFactor).toBe(1);
    expect(r.contrarian).toBe(false);
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
    // fee per level: (40 + .96 + .51x)/(100 + x) = .475 -> x = 186.86 sh @ .5 -> S = 133.43
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

describe("sizeTrade Rev 7 refinements", () => {
  it("fee is charged per level walked, not at the VWAP", () => {
    // $100 fills 100 sh @ .4 ($40) + 100 sh @ .6 ($60): fees .04*.24*100 twice; all-in = (100 + 1.92) / 200
    const asks = [{ price: 0.4, size: 100 }, { price: 0.6, size: 100 }];
    expect(allInPrice(asks, 100, 0.04)).toBeCloseTo((100 + 2 * 100 * 0.04 * 0.24) / 200, 12);
    expect(allInPrice(asks, 100, 0.04)).not.toBeCloseTo(0.5 + 0.04 * 0.25, 4);
    expect(allInPrice(asks, 0, 0.04)).toBeCloseTo(0.4 + 0.04 * 0.24, 12);
    expect(allInPrice(asks, 101, 0.04)).toBeNull();
    expect(allInPrice([], 1, 0.04)).toBeNull();
    const r = sizeTrade({ ...base, asks, pHat: 0.95, c: 1, settings: { ...S, bankroll: 1e6, capFrac: 1e-4, kelly: 1 } })!;
    expect(r.sizeUsd).toBeCloseTo(100, 9);
    expect(r.k).toBeCloseTo((100 + 1.92) / 200, 9);
    expect(r.shares).toBeCloseTo(200, 9);
  });
  it("fee exponent 2 lowers the fee at the mid: k0 = .40 + .04*(.24)^2", () => {
    expect(allInPrice(base.asks, 0, 0.04, 2)).toBeCloseTo(0.4 + 0.04 * 0.24 * 0.24, 12);
    const r1 = sizeTrade(base)!, r2 = sizeTrade({ ...base, feeExponent: 2 })!;
    expect(r2.k).toBeCloseTo(0.4 + 0.04 * 0.24 * 0.24, 12);
    expect(r2.k).toBeLessThan(r1.k);
    expect(r2.e).toBeGreaterThan(r1.e);
    expect(sizeTrade({ ...base, feeExponent: null })!.k).toBeCloseTo(r1.k, 12); // null = 1
  });
  it("exitFactor", () => {
    expect(exitFactor(1000, 100)).toBe(1);
    expect(exitFactor(50, 100)).toBeCloseTo(0.75, 12);
    expect(exitFactor(0, 100)).toBeCloseTo(0.5, 12);
    expect(exitFactor(0, 0)).toBe(1);
    expect(exitFactor(null, 100)).toBeCloseTo(0.75, 12);
  });
  it("rank is scaled by the exit factor of the traded side's bids", () => {
    const full = sizeTrade(base)!;
    const thin = sizeTrade({ ...base, bids: [{ price: 0.38, size: 10 }] })!; // $3.8 of exit vs ~$36 stake
    expect(thin.sizeUsd).toBeCloseTo(full.sizeUsd, 9);
    expect(thin.exitFactor).toBeCloseTo(0.5 + 0.5 * (3.8 / thin.sizeUsd), 9);
    expect(thin.rank).toBeCloseTo(full.rank * thin.exitFactor, 9);
    const none = sizeTrade({ ...base, bids: [] })!;
    expect(none.exitFactor).toBe(0.75); // unknown exit depth: neutral
  });
  it("contrarian only when the model disagrees with both mid and flow", () => {
    expect(sizeTrade({ ...base, flow24h: -100 })!.contrarian).toBe(true); // model .6 > mid .39, crowd selling
    expect(sizeTrade({ ...base, flow24h: 100 })!.contrarian).toBe(false);
    expect(sizeTrade({ ...base, flow24h: 0 })!.contrarian).toBe(false);
    expect(sizeTrade({ ...base, flow24h: null })!.contrarian).toBe(false);
    expect(sizeTrade(base)!.contrarian).toBe(false);
    expect(sizeTrade({ ...base, pHat: 0.39, flow24h: -100 })!.contrarian).toBe(false); // agrees with mid
    // NO side: model below market, crowd buying YES
    const no = sizeTrade({ ...base, bids: [{ price: 0.6, size: 100 }], asks: [{ price: 0.62, size: 100 }], pMid: 0.61, pHat: 0.3, flow24h: 50 })!;
    expect(no.side).toBe("NO");
    expect(no.contrarian).toBe(true);
  });
  it("extremize sharpens pHat in logit space; 1 is a no-op; settings.extremize is the fallback", () => {
    expect(extremizeP(0.5, 2)).toBeCloseTo(0.5, 12);
    expect(extremizeP(0.6, 2)).toBeCloseTo(0.36 / (0.36 + 0.16), 12);
    expect(extremizeP(0.6, 1)).toBe(0.6);
    expect(extremizeP(0, 2)).toBe(0);
    expect(extremizeP(1, 2)).toBe(1);
    const plain = sizeTrade(base)!;
    expect(sizeTrade({ ...base, extremize: 1 })).toEqual(plain);
    const sharp = sizeTrade({ ...base, extremize: 2 })!;
    expect(sharp.pHat).toBeCloseTo(0.36 / 0.52, 12);
    expect(sharp.pPost).toBeGreaterThan(plain.pPost);
    expect(sizeTrade({ ...base, settings: { ...S, extremize: 2 } as typeof S })).toEqual(sharp);
    expect(sizeTrade({ ...base, extremize: 0.5 })!.pHat).toBeLessThan(0.6);
  });
});

describe("longshot guard", () => {
  // YES book at 4/5c: a cheap YES needs fair >= 2x its cost, the 95c NO only minEdge
  const tail: SizeInput = { ...base, bids: [{ price: 0.04, size: 5000 }], asks: [{ price: 0.05, size: 5000 }], pMid: 0.045, feeRate: 0, c: 1, daysLeft: 30 };
  it("needEdge: the price itself under 15c, minEdge above", () => {
    expect(needEdge(0.05, 0.02)).toBe(0.05);
    expect(needEdge(0.01, 0.02)).toBe(0.02);
    expect(needEdge(0.5, 0.02)).toBe(0.02);
  });
  it("a cheap YES on a tail estimate is not sized: 8c fair vs 5c cost", () => {
    const r = sizeTrade({ ...tail, pHat: 0.08 })!;
    expect(r.side).toBe("YES");
    expect(r.e).toBeCloseTo(0.03, 12);
    expect(r.sizeUsd).toBe(0);
  });
  it("double the price is sized: 11c fair vs 5c cost", () => {
    expect(sizeTrade({ ...tail, pHat: 0.11 })!.sizeUsd).toBeGreaterThan(0);
  });
  it("the overpriced longshot is harvested from the NO side: 1% fair vs a 4c YES bid", () => {
    const r = sizeTrade({ ...tail, pHat: 0.01 })!;
    expect(r.side).toBe("NO");
    expect(r.k).toBeCloseTo(0.96, 12);
    expect(r.e).toBeCloseTo(0.03, 12);
    expect(r.sizeUsd).toBeGreaterThan(0);
  });
});

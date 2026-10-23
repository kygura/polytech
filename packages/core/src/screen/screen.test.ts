import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Market, type Snapshot } from "../types";
import { crowd, factorA, factorI, factorL, factorT, pass1, priority, screen } from "./screen";

const NOW = Date.UTC(2026, 9, 15);
const DAY = 86_400_000;
const market: Market = {
  conditionId: "m1", eventId: "e1", question: "Q?", rules: "r", category: "politics", tags: ["us"],
  endDate: NOW + 30 * DAY, negRiskGroup: null, feeRate: 0.04, open: true, acceptingOrders: true, inDispute: false,
};
const snap: Snapshot = {
  conditionId: "m1", ts: NOW,
  bids: [{ price: 0.48, size: 1000 }],
  asks: [{ price: 0.52, size: 1000 }],
  vol24h: 0, oi: 0, top10Share: 0.4, lastTradeTs: NOW - 24 * 3600_000,
};
const S = DEFAULT_SETTINGS;

describe("pass1", () => {
  it("passes a healthy market", () => expect(pass1(market, snap, S, NOW)).toEqual({ ok: true }));
  it.each([
    [{ open: false }, "closed"],
    [{ acceptingOrders: false }, "not_accepting"],
    [{ inDispute: true }, "disputed"],
    [{ endDate: NOW + 1 * DAY }, "days_out_of_range"],
    [{ endDate: NOW + 121 * DAY }, "days_out_of_range"],
    [{ category: "Sports" }, "excluded_category"],
  ] as const)("rejects %j as %s", (patch, reason) => {
    const s = { ...S, filters: { ...S.filters, excludedCategories: ["sports"] } };
    expect(pass1({ ...market, ...patch }, snap, s, NOW)).toEqual({ ok: false, reason });
  });
  it("accepts the day-range edges (2 and 120 days)", () => {
    expect(pass1({ ...market, endDate: NOW + 2 * DAY }, snap, S, NOW).ok).toBe(true);
    expect(pass1({ ...market, endDate: NOW + 120 * DAY }, snap, S, NOW).ok).toBe(true);
  });
  it("excluded category also matches tags", () => {
    const s = { ...S, filters: { ...S.filters, excludedCategories: ["us"] } };
    expect(pass1(market, snap, s, NOW)).toEqual({ ok: false, reason: "excluded_category" });
  });
  it("tail prices -> no_headroom (within minEdge of 0 or 1)", () => {
    const at = (p: number) => ({ ...snap, bids: [{ price: p - 0.001, size: 1e6 }], asks: [{ price: p + 0.001, size: 1e6 }] });
    expect(pass1(market, at(0.004), S, NOW)).toEqual({ ok: false, reason: "no_headroom" });
    expect(pass1(market, at(0.997), S, NOW)).toEqual({ ok: false, reason: "no_headroom" });
    expect(pass1(market, at(0.03), S, NOW).ok).toBe(true);
    expect(pass1(market, at(0.97), S, NOW).ok).toBe(true);
  });
  it("empty book -> no_book; thin book -> thin_depth", () => {
    expect(pass1(market, { ...snap, asks: [] }, S, NOW)).toEqual({ ok: false, reason: "no_book" });
    // mid .50; asks .52*300=156 <200, bids .48*300=144 <200
    const thin = { ...snap, bids: [{ price: 0.48, size: 300 }], asks: [{ price: 0.52, size: 300 }] };
    expect(pass1(market, thin, S, NOW)).toEqual({ ok: false, reason: "thin_depth" });
  });
  it("depth on either side suffices", () => {
    const oneSide = { ...snap, bids: [{ price: 0.48, size: 10 }], asks: [{ price: 0.52, size: 1000 }] };
    expect(pass1(market, oneSide, S, NOW).ok).toBe(true);
  });
});

describe("factorI", () => {
  it("averages spread, staleness, pinning, longshot", () => {
    // spread .10 -> 1; 48h -> 1; mid .50 pinned -> 1; not longshot -> 0  => .75
    const b = { ...snap, bids: [{ price: 0.45, size: 1 }], asks: [{ price: 0.55, size: 1 }], lastTradeTs: NOW - 48 * 3600_000 };
    expect(factorI(b, NOW)).toBeCloseTo(0.75, 9);
  });
  it("tight, fresh, unpinned, mid-range -> 0", () => {
    const b = { ...snap, bids: [{ price: 0.4, size: 1 }, ], asks: [{ price: 0.42, size: 1 }], lastTradeTs: NOW };
    // spread .02 -> .2 ; stale 0 ; mid .41 -> not pinned (.01 from .40 > .005); longshot 0 => .05
    expect(factorI(b, NOW)).toBeCloseTo(0.05, 9);
  });
  it("longshot zone and missing last trade count as maxed", () => {
    const b = { ...snap, bids: [{ price: 0.02, size: 1 }], asks: [{ price: 0.04, size: 1 }], lastTradeTs: null };
    // spread .02->.2; stale 1; mid .03 pinned? .03 is .02 from .05 -> no; longshot 1 => (.2+1+0+1)/4
    expect(factorI(b, NOW)).toBeCloseTo(0.55, 9);
  });
  it("unknown trade flow is neutral, not stale", () => {
    const b = { ...snap, lastTradeTs: null };
    expect(factorI({ ...b, flowUnknown: true }, NOW)).toBeLessThan(factorI(b, NOW));
  });
  it("empty book -> 0", () => expect(factorI({ ...snap, bids: [] }, NOW)).toBe(0));
});

describe("factorL", () => {
  it("fills against both targets within 3c of best ask", () => {
    // asks .50x100 ($50), .52x200 ($104), .60x1000 (outside 3c). fillable $154
    const b = { ...snap, asks: [{ price: 0.5, size: 100 }, { price: 0.52, size: 200 }, { price: 0.6, size: 1000 }] };
    const r = factorL(b, S);
    expect(r.tier).toBe("small-cap"); // 154/2000=.077 <.5
    expect(r.L).toBeCloseTo(154 / 200 > 1 ? 1 : 154 / 200, 9); // .77
  });
  it("tier size when big target >= half fillable", () => {
    const b = { ...snap, asks: [{ price: 0.5, size: 4000 }] }; // $2000
    expect(factorL(b, S)).toEqual({ L: 1, tier: "size" });
  });
  it("empty asks -> L 0 small-cap", () => {
    expect(factorL({ ...snap, asks: [] }, S)).toEqual({ L: 0, tier: "small-cap" });
  });
});

describe("factorT", () => {
  it("1 up to 60 days then 60/d", () => {
    expect(factorT(10, S)).toBe(1);
    expect(factorT(60, S)).toBe(1);
    expect(factorT(120, S)).toBeCloseTo(0.5, 12);
  });
  it("<=0 days -> 0", () => expect(factorT(0, S)).toBe(0));
});

describe("crowd", () => {
  it("C = mean(top10, |flow|, |skew|); side from sign of flow+skew", () => {
    const y = crowd({ top10Share: 0.6, netFlow: 0.3, skew: 0.3 });
    expect(y.c).toBeCloseTo(0.4, 12);
    expect(y.side).toBe("YES");
    const n = crowd({ top10Share: 0.3, netFlow: -0.6, skew: 0 });
    expect(n.c).toBeCloseTo(0.3, 12);
    expect(n.side).toBe("NO");
  });
  it("balanced -> null side; clamps to 0..1", () => {
    expect(crowd({ top10Share: 0.2, netFlow: 0.1, skew: -0.1 }).side).toBeNull();
    expect(crowd({ top10Share: 2, netFlow: 5, skew: -5 }).c).toBe(1);
  });
});

describe("factorA (attention)", () => {
  it("quiet markets get full credit; each 10x of volume takes 0.35 off, floored at 0.3", () => {
    expect(factorA({ vol24h: 0 })).toBe(1);
    expect(factorA({ vol24h: 5_000 })).toBe(1);
    expect(factorA({ vol24h: 50_000 })).toBeCloseTo(0.65, 12);
    expect(factorA({ vol24h: 500_000 })).toBeCloseTo(0.3, 12);
    expect(factorA({ vol24h: 5e7 })).toBe(0.3);
    expect(factorA({ vol24h: NaN })).toBe(1);
  });
  it("priority: a quiet market outranks an identical busy one", () => {
    expect(priority({ R: 0.8, I: 0.5, L: 0.5, T: 1, C: 0.4, A: 1 }, S)).toBeCloseTo(priority({ R: 0.8, I: 0.5, L: 0.5, T: 1, C: 0.4, A: 0.3 }, S) / 0.3, 12);
  });
});

describe("priority", () => {
  it("R*I*L*T*(1+0.5C)", () => {
    expect(priority({ R: 0.8, I: 0.5, L: 0.5, T: 1, C: 0.4 }, S)).toBeCloseTo(0.8 * 0.5 * 0.5 * 1 * 1.2, 12);
  });
});

describe("screen", () => {
  it("builds a ScreenResult", () => {
    const r = screen({
      market, snap, R: 0.9, crowd: { top10Share: 0.4, netFlow: 0, skew: 0 }, structural: true, settings: S, now: NOW,
    });
    expect(r.conditionId).toBe("m1");
    expect(r.T).toBe(1);
    expect(r.C).toBeCloseTo(0.4 / 3, 12);
    expect(r.structural).toBe(true);
    expect(r.priority).toBeCloseTo(r.R * r.I * r.L * r.T * (1 + 0.5 * r.C) * r.A, 12);
  });
});

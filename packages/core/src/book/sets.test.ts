import { describe, expect, it } from "vitest";
import { autoAllowed, checkSet, exitDecision, gateStats, setLegPlan, unwindPlan } from "./sets";
import { gateProgress } from "./autonomy";
import type { Exposure, Limits } from "./risk";

const L: Limits = { perTradeUsd: 50, perTradePct: 0.05, perMarket: 100, perEvent: 100, perCategory: 300, totalOpen: 500, dailyNotional: 500, dailyLoss: 100 };
const X: Exposure = { bankroll: 1000, byMarket: {}, byEvent: {}, byCategory: {}, totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 };
const ev = { eventId: "e", category: "pol" };

describe("checkSet", () => {
  it("sums legs as one order on one event", () => {
    expect(checkSet([{ sizeUsd: 20, marketId: "a" }, { sizeUsd: 20, marketId: "b" }], ev, X, L).ok).toBe(true);
    const r = checkSet([{ sizeUsd: 30, marketId: "a" }, { sizeUsd: 30, marketId: "b" }], ev, X, L);
    expect(r.violations.map((v) => v.rule)).toEqual(["PER_TRADE_USD", "PER_TRADE_PCT"]);
    expect(r.violations[0]).toMatchObject({ value: 60 });
  });
  it("counts existing event exposure and per-market per leg", () => {
    const r = checkSet([{ sizeUsd: 20, marketId: "a" }, { sizeUsd: 20, marketId: "b" }], ev, { ...X, byEvent: { e: 70 }, byMarket: { b: 90 } }, L);
    expect(r.violations.map((v) => v.rule)).toEqual(["PER_EVENT", "PER_MARKET"]);
  });
});

describe("autoAllowed", () => {
  const l3 = { perTradeUsd: 25, dailyNotional: 100, categoryAllowlist: ["pol"], structuralAuto: false };
  it("passes inside limits", () => expect(autoAllowed({ sizeUsd: 25, category: "pol" }, l3, 75)).toEqual({ ok: true }));
  it("fails closed on empty allowlist", () => expect(autoAllowed({ sizeUsd: 1, category: "pol" }, { ...l3, categoryAllowlist: [] }, 0).reason).toBe("CATEGORY_NOT_ALLOWED"));
  it("reasons", () => {
    expect(autoAllowed({ sizeUsd: 26, category: "pol" }, l3, 0).reason).toBe("L3_PER_TRADE");
    expect(autoAllowed({ sizeUsd: 10, category: "pol" }, l3, 91).reason).toBe("L3_DAILY_NOTIONAL");
    expect(autoAllowed({ sizeUsd: 10, category: "pol", isSet: true }, l3, 0).reason).toBe("STRUCTURAL_NOT_AUTO");
    expect(autoAllowed({ sizeUsd: 10, category: "pol", isSet: true }, { ...l3, structuralAuto: true }, 0).ok).toBe(true);
  });
});

const leg = (id: string, ask: number, askSize: number, bid: number, bidSize: number) => ({ conditionId: id, yesToken: id + "y", noToken: id + "n", ask: { price: ask, size: askSize }, bid: { price: bid, size: bidSize } });

describe("setLegPlan", () => {
  it("buy-all: YES tokens, thinnest first, caps, edge", () => {
    const r = setLegPlan("buy-all", [leg("a", 0.3, 100, 0.2, 5), leg("b", 0.3, 40, 0.2, 5), leg("c", 0.3, 70, 0.2, 5)], 10, 0, 0.01);
    expect(r).toMatchObject({ ok: true, totalCost: 9.3, edge: 0.7 });
    if (r.ok) {
      expect(r.legs.map((g) => g.token)).toEqual(["by", "cy", "ay"]);
      expect(r.legs[0]).toMatchObject({ limit: 0.31, shares: 10 });
    }
  });
  it("sell-all: NO tokens at 1 - bid, pays n-1", () => {
    const r = setLegPlan("sell-all", [leg("a", 0.9, 5, 0.5, 50), leg("b", 0.9, 5, 0.6, 20), leg("c", 0.9, 5, 0.2, 30)], 10, 0, 0);
    // costs 0.5+0.4+0.8=1.7 < 2
    expect(r).toMatchObject({ ok: true, edge: 3 });
    if (r.ok) expect(r.legs.map((g) => g.token)).toEqual(["bn", "cn", "an"]);
  });
  it("refuses when caps eat the edge, or depth is short", () => {
    const l = [leg("a", 0.49, 100, 0, 0), leg("b", 0.49, 100, 0, 0)];
    expect(setLegPlan("buy-all", l, 10, 0, 0.01)).toEqual({ ok: false, reason: "NO_EDGE" });
    expect(setLegPlan("buy-all", l, 10, 0, 0)).toMatchObject({ ok: true });
    expect(setLegPlan("buy-all", l, 101, 0, 0)).toEqual({ ok: false, reason: "TOO_THIN" });
  });
  it("fees count against the edge", () => {
    const l = [leg("a", 0.49, 100, 0, 0), leg("b", 0.49, 100, 0, 0)];
    expect(setLegPlan("buy-all", l, 10, 0.05, 0)).toEqual({ ok: false, reason: "NO_EDGE" });
  });
});

describe("unwindPlan", () => {
  it("SELL with floor fill-0.02, clamped at 0.01", () => {
    const r = unwindPlan([{ conditionId: "a", token: "ay", shares: 5, fillPrice: 0.3 }, { conditionId: "b", token: "by", shares: 5, fillPrice: 0.02 }]);
    expect(r.map((x) => [x.side, x.floor])).toEqual([["SELL", 0.28], ["SELL", 0.01]]);
  });
});

describe("exitDecision", () => {
  const pos = { shares: 5 };
  it("killed / flipped / hold / nothing held", () => {
    expect(exitDecision({ status: "killed", side: "YES" }, null, pos)).toEqual({ exit: true, reason: "killed" });
    expect(exitDecision({ status: "open", side: "YES" }, { side: "NO" }, pos)).toEqual({ exit: true, reason: "flipped" });
    expect(exitDecision({ status: "open", side: "YES" }, { side: "YES" }, pos)).toEqual({ exit: false });
    expect(exitDecision({ status: "killed", side: "YES" }, null, { shares: 0 })).toEqual({ exit: false });
  });
});

describe("gateStats", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const t = (o: object) => ({ approved: true, side: "BUY" as const, modeledPrice: 0.4, fillPrice: 0.4, at: new Date("2026-10-10T00:00:00Z"), ...o });
  it("counts, signs slippage, windows edge to 30d", () => {
    const s = gateStats([t({ fillPrice: 0.41, realizedPnl: 2 }), t({ approved: false, side: "SELL", fillPrice: 0.39 }), t({ at: new Date("2026-08-01T00:00:00Z"), realizedPnl: 50 })], now);
    expect(s).toMatchObject({ approvedLiveTrades: 2, liveTrades: 3, realizedEdge30d: 2 });
    expect(s.avgSlippage).toBeCloseTo(0.02 / 3);
  });
  it("empty gives undefined slippage and feeds gateProgress", () => {
    const s = gateStats([], now);
    expect(s.avgSlippage).toBeUndefined();
    expect(gateProgress("L2->L3", s).met).toBe(false);
  });
});

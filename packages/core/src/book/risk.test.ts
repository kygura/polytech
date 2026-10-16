import { describe, expect, it } from "vitest";
import { checkOrder, type Exposure, type Limits } from "./risk";

const limits: Limits = {
  perTradeUsd: 50, perTradePct: 0.05, perMarket: 100, perEvent: 150, perCategory: 300,
  totalOpen: 500, dailyNotional: 400, dailyLoss: 100,
};
const empty: Exposure = { bankroll: 1000, byMarket: {}, byEvent: {}, byCategory: {}, totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 };
const order = { sizeUsd: 40, marketId: "m1", eventId: "e1", category: "c1" };
const rules = (r: ReturnType<typeof checkOrder>) => r.violations.map((v) => v.rule);

describe("checkOrder", () => {
  it("NaN fails closed", () => {
    expect(checkOrder({ ...order, sizeUsd: NaN }, empty, limits).ok).toBe(false);
    expect(rules(checkOrder(order, { ...empty, dailyRealizedLoss: NaN }, limits))).toEqual(["DAILY_LOSS"]);
  });
  it("ok on empty book", () => expect(checkOrder(order, empty, limits)).toEqual({ ok: true, violations: [] }));
  it("per trade USD and % of bankroll", () => {
    expect(rules(checkOrder({ ...order, sizeUsd: 60 }, empty, limits))).toEqual(["PER_TRADE_USD", "PER_TRADE_PCT"]);
    expect(checkOrder({ ...order, sizeUsd: 50 }, empty, limits).ok).toBe(true);
  });
  it("per market: existing 70 + 40 = 110 > 100; exactly 100 is ok", () => {
    expect(rules(checkOrder(order, { ...empty, byMarket: { m1: 70 } }, limits))).toEqual(["PER_MARKET"]);
    expect(checkOrder({ ...order, sizeUsd: 30 }, { ...empty, byMarket: { m1: 70 } }, limits).ok).toBe(true);
  });
  it("per event (neg-risk group = one eventId)", () => {
    const v = checkOrder(order, { ...empty, byEvent: { e1: 120 } }, limits);
    expect(rules(v)).toEqual(["PER_EVENT"]);
    expect(v.violations[0]).toEqual({ rule: "PER_EVENT", limit: 150, value: 160 });
  });
  it("per category, total open, daily notional", () => {
    expect(rules(checkOrder(order, { ...empty, byCategory: { c1: 270 } }, limits))).toEqual(["PER_CATEGORY"]);
    expect(rules(checkOrder(order, { ...empty, totalOpen: 470 }, limits))).toEqual(["TOTAL_OPEN"]);
    expect(rules(checkOrder(order, { ...empty, dailyNotional: 370 }, limits))).toEqual(["DAILY_NOTIONAL"]);
  });
  it("daily realized loss at limit blocks", () => {
    expect(rules(checkOrder(order, { ...empty, dailyRealizedLoss: 100 }, limits))).toEqual(["DAILY_LOSS"]);
    expect(checkOrder(order, { ...empty, dailyRealizedLoss: 99 }, limits).ok).toBe(true);
  });
  it("collects several", () => {
    const r = checkOrder(order, { ...empty, byMarket: { m1: 100 }, totalOpen: 500 }, limits);
    expect(rules(r)).toEqual(["PER_MARKET", "TOTAL_OPEN"]);
    expect(r.ok).toBe(false);
  });
});

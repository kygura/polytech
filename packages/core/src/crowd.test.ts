import { describe, expect, it } from "vitest";
import { holderMetrics, median, tradeMetrics, type TradeInput } from "./crowd";

describe("holderMetrics", () => {
  it("hhi, top1, top5 over the rows given", () => {
    const m = holderMetrics([{ amount: 50 }, { amount: 30 }, { amount: 10 }, { amount: 5 }, { amount: 3 }, { amount: 2 }])!;
    expect(m.holderCount).toBe(6);
    expect(m.top1Share).toBeCloseTo(0.5, 12);
    expect(m.top5Share).toBeCloseTo(0.98, 12);
    expect(m.hhi).toBeCloseTo(0.25 + 0.09 + 0.01 + 0.0025 + 0.0009 + 0.0004, 12);
  });
  it("single holder is fully concentrated; order and junk rows do not matter", () => {
    expect(holderMetrics([{ amount: 7 }])).toEqual({ holderCount: 1, hhi: 1, top1Share: 1, top5Share: 1 });
    expect(holderMetrics([{ amount: 0 }, { amount: -1 }, { amount: NaN }, { amount: 3 }, { amount: 1 }])).toMatchObject({ holderCount: 2, top1Share: 0.75 });
  });
  it("null when nothing is held", () => {
    expect(holderMetrics([])).toBeNull();
    expect(holderMetrics([{ amount: 0 }])).toBeNull();
  });
});

describe("tradeMetrics", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const H = 3_600_000;
  const t = (o: Partial<TradeInput>): TradeInput => ({ side: "BUY", size: 100, price: 0.5, ts: now - H, outcome: "YES", ...o });
  it("signed flow: buy YES / sell NO positive, sell YES / buy NO negative", () => {
    const m = tradeMetrics([
      t({}), // +50
      t({ side: "SELL", size: 20 }), // -10
      t({ outcome: "NO", size: 40 }), // -20
      t({ outcome: "NO", side: "SELL", size: 10 }), // +5
    ], now);
    expect(m.flow24h).toBeCloseTo(25, 9);
    expect(m.tradeMedian).toBeCloseTo((10 + 20) / 2, 9); // tickets 50, 10, 20, 5
    expect(m.largeTrade24h).toBe(false);
    expect(m.lastTradeTs).toBe(now - H);
  });
  it("window: older trades only inform lastTradeTs; future-stamped rows ignored", () => {
    const m = tradeMetrics([t({ ts: now - 30 * H, size: 2000 }), t({ ts: now - 2 * H }), t({ ts: now + H, size: 5000 })], now);
    expect(m.flow24h).toBeCloseTo(50, 9);
    expect(m.largeTrade24h).toBe(false);
    expect(m.lastTradeTs).toBe(now + H);
    expect(tradeMetrics([t({ ts: now - 30 * H })], now)).toEqual({ flow24h: 0, tradeMedian: null, largeTrade24h: false, lastTradeTs: now - 30 * H });
  });
  it("large trade at >= $500; thresholds configurable", () => {
    expect(tradeMetrics([t({ size: 1000 })], now).largeTrade24h).toBe(true); // $500
    expect(tradeMetrics([t({ size: 999 })], now).largeTrade24h).toBe(false);
    expect(tradeMetrics([t({ size: 999 })], now, { largeUsd: 100 }).largeTrade24h).toBe(true);
    expect(tradeMetrics([t({ ts: now - 2 * H })], now, { windowMs: H }).flow24h).toBe(0);
  });
  it("no trades is a real zero, not missing", () => {
    expect(tradeMetrics([], now)).toEqual({ flow24h: 0, tradeMedian: null, largeTrade24h: false, lastTradeTs: null });
  });
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

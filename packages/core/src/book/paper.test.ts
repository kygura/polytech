import { describe, expect, it } from "vitest";
import { applyFill, paperFill, realizedEdge, settle } from "./paper";

describe("paperFill", () => {
  const asks = [{ price: 0.5, size: 100 }, { price: 0.55, size: 100 }];
  it("walks levels: $75 = 100@0.50 ($50) + 25/0.55 shares", () => {
    const r = paperFill(asks, 75, 0.02);
    expect(r.shares).toBeCloseTo(1600 / 11, 9);
    expect(r.avgPrice).toBeCloseTo(0.515625, 9); // 75 / (1600/11)
    expect(r.filled).toBeCloseTo(75, 9);
    expect(r.complete).toBe(true);
    expect(r.fee).toBeCloseTo(0.7265625, 7); // 0.02 * .515625*.484375 * 1600/11
  });
  it("sorts asks ascending", () => {
    expect(paperFill([...asks].reverse(), 25).avgPrice).toBeCloseTo(0.5, 10);
  });
  it("thin book: partial, incomplete", () => {
    const r = paperFill([{ price: 0.5, size: 10 }], 10);
    expect(r).toMatchObject({ shares: 10, avgPrice: 0.5, filled: 5, complete: false, fee: 0 });
  });
  it("empty book fills nothing", () => {
    expect(paperFill([], 10)).toMatchObject({ shares: 0, filled: 0, avgPrice: 0, complete: false });
  });
});

describe("positions", () => {
  const p0 = { shares: 0, avgCost: 0, realizedPnl: 0 };
  it("buys average cost incl. fees; sells realize pnl", () => {
    let p = applyFill(p0, { side: "buy", shares: 100, price: 0.5, fee: 0 });
    expect(p).toEqual({ shares: 100, avgCost: 0.5, realizedPnl: 0 });
    p = applyFill(p, { side: "buy", shares: 100, price: 0.6, fee: 2 }); // (50+60+2)/200
    expect(p.avgCost).toBeCloseTo(0.56, 10);
    expect(p.shares).toBe(200);
    p = applyFill(p, { side: "sell", shares: 50, price: 0.7, fee: 1 }); // 50*.14 - 1
    expect(p.realizedPnl).toBeCloseTo(6, 10);
    expect(p.shares).toBe(150);
    expect(p.avgCost).toBeCloseTo(0.56, 10);
    expect(settle(p, 1).realizedPnl).toBeCloseTo(6 + 66, 10); // 150*(1-.56)
    expect(settle(p, 0).realizedPnl).toBeCloseTo(6 - 84, 10);
    expect(settle(p, 1).shares).toBe(0);
  });
  it("overselling throws", () => {
    expect(() => applyFill(p0, { side: "sell", shares: 1, price: 0.5, fee: 0 })).toThrow(RangeError);
  });
});

describe("realizedEdge", () => {
  it("share-weighted over resolved fills only", () => {
    const r = realizedEdge([
      { shares: 100, avgPrice: 0.5, fee: 1, modeledEdge: 0.05, outcome: 1 }, // +49
      { shares: 100, avgPrice: 0.4, fee: 0, modeledEdge: 0.1, outcome: 0 }, // -40
      { shares: 500, avgPrice: 0.4, fee: 0, modeledEdge: 0.5, outcome: null },
    ]);
    expect(r.n).toBe(2);
    expect(r.realized).toBeCloseTo(0.045, 10); // 9/200
    expect(r.modeled).toBeCloseTo(0.075, 10); // 15/200
    expect(r.gap).toBeCloseTo(-0.03, 10);
  });
  it("nothing resolved -> zeros", () => {
    expect(realizedEdge([])).toEqual({ n: 0, realized: 0, modeled: 0, gap: 0 });
  });
});

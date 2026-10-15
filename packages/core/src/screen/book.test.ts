import { describe, expect, it } from "vitest";
import { depthWithin, midOf, mirror, vwapForUsd } from "./book";

const asks = [
  { price: 0.6, size: 100 },
  { price: 0.5, size: 100 },
];

describe("midOf", () => {
  it("averages best bid and best ask regardless of order", () => {
    expect(midOf([{ price: 0.3, size: 1 }, { price: 0.4, size: 1 }], asks)).toBeCloseTo(0.45, 12);
  });
  it("null when a side is empty", () => {
    expect(midOf([], asks)).toBeNull();
    expect(midOf([{ price: 0.4, size: 1 }], [])).toBeNull();
  });
});

describe("depthWithin", () => {
  it("sums USD notional of levels within N cents of ref (inclusive)", () => {
    // ref .50, 5c: .50->$50, .55->$27.5, .60 excluded (10c away)
    const lv = [{ price: 0.5, size: 100 }, { price: 0.55, size: 50 }, { price: 0.6, size: 100 }];
    expect(depthWithin(lv, 0.5, 5)).toBeCloseTo(77.5, 9);
  });
  it("empty book is 0", () => expect(depthWithin([], 0.5, 5)).toBe(0));
});

describe("vwapForUsd", () => {
  it("fills inside the first level at its price", () => {
    expect(vwapForUsd(asks, 25)).toBeCloseTo(0.5, 12);
  });
  it("walks levels: $80 = 100@.5 ($50) + 50@.6 ($30) -> 80/150", () => {
    expect(vwapForUsd(asks, 80)).toBeCloseTo(80 / 150, 12);
  });
  it("usd <= 0 returns best ask", () => {
    expect(vwapForUsd(asks, 0)).toBe(0.5);
  });
  it("null when size exceeds depth ($110 total) or book empty", () => {
    expect(vwapForUsd(asks, 110.01)).toBeNull();
    expect(vwapForUsd(asks, 110)).not.toBeNull();
    expect(vwapForUsd([], 10)).toBeNull();
  });
  it("ignores junk levels", () => {
    expect(vwapForUsd([{ price: 0, size: 5 }, { price: 0.5, size: 0 }, { price: 0.4, size: 10 }], 2)).toBe(0.4);
  });
});

describe("mirror", () => {
  it("maps price to 1-price", () => {
    expect(mirror([{ price: 0.3, size: 7 }])).toEqual([{ price: 0.7, size: 7 }]);
  });
});

import { describe, expect, it } from "vitest";
import { ariaLabel, capLabel, curveOf, curveSizes, readout, sideBook, sizeAt, usdLabel, X_MAX, X_MIN, xFrac, yFrac } from "./slippage";

const book = {
  bids: [{ price: 0.4, size: 5000 }, { price: 0.39, size: 5000 }],
  asks: [{ price: 0.42, size: 1000 }, { price: 0.43, size: 2000 }, { price: 0.5, size: 20_000 }],
};

describe("log-x scale", () => {
  it("$10 .. $10k map to 0 .. 1, decades are evenly spaced", () => {
    expect(xFrac(10)).toBe(0);
    expect(xFrac(10_000)).toBe(1);
    expect(xFrac(100)).toBeCloseTo(1 / 3);
    expect(xFrac(1000)).toBeCloseTo(2 / 3);
  });
  it("clamps outside the domain and inverts", () => {
    expect(xFrac(1)).toBe(0);
    expect(xFrac(1e6)).toBe(1);
    expect(sizeAt(0)).toBeCloseTo(X_MIN);
    expect(sizeAt(1)).toBeCloseTo(X_MAX);
    expect(sizeAt(xFrac(620))).toBeCloseTo(620);
  });
  it("curve sizes are log-spaced and span the axis", () => {
    const s = curveSizes(5);
    expect(s[0]).toBeCloseTo(10);
    expect(s[4]).toBeCloseTo(10_000);
    expect(s[1]! / s[0]!).toBeCloseTo(s[2]! / s[1]!);
  });
});

describe("y scale", () => {
  it("0 at the best ask, 1 at ask + 10c, clamped", () => {
    expect(yFrac(0.42, 0.42)).toBe(0);
    expect(yFrac(0.47, 0.42)).toBeCloseTo(0.5);
    expect(yFrac(0.52, 0.42)).toBeCloseTo(1);
    expect(yFrac(0.9, 0.42)).toBe(1);
    expect(yFrac(0.3, 0.42)).toBe(0);
  });
});

describe("curveOf", () => {
  it("YES: starts at the best ask, never decreases, capacities grow with epsilon", () => {
    const c = curveOf(book, "YES")!;
    expect(c.ask).toBe(0.42);
    expect(c.points[0]!.vwap).toBeCloseTo(0.42);
    expect(c.points.every((p, i) => i === 0 || p.vwap >= c.points[i - 1]!.vwap - 1e-12)).toBe(true);
    expect(c.caps.map((k) => k.cents)).toEqual([0.5, 1, 2]);
    expect(c.caps[0]!.usd).toBeLessThanOrEqual(c.caps[1]!.usd);
    expect(c.caps[1]!.usd).toBeLessThanOrEqual(c.caps[2]!.usd);
    expect(c.caps[0]!.usd).toBeGreaterThanOrEqual(0.42 * 1000 - 1e-6); // the whole best level fills at the ask
  });
  it("NO uses the complement book: NO asks = 1 - YES bids", () => {
    expect(sideBook(book, "NO").asks.map((l) => l.price)).toEqual([0.6, 0.61]);
    const c = curveOf(book, "NO")!;
    expect(c.ask).toBeCloseTo(0.6);
  });
  it("under two ask levels there is no curve", () => {
    expect(curveOf({ bids: book.bids, asks: [book.asks[0]!] }, "YES")).toBeNull();
    expect(curveOf({ bids: book.bids, asks: [] }, "YES")).toBeNull();
    expect(curveOf({ bids: [{ price: 0.4, size: 10 }], asks: book.asks }, "NO")).toBeNull(); // one YES bid = one NO ask
  });
});

describe("labels", () => {
  it("usd ticks and capacity markers", () => {
    expect([10, 100, 1000, 10_000, 620, 1840].map(usdLabel)).toEqual(["$10", "$100", "$1k", "$10k", "$620", "$1,840"]);
    expect(capLabel({ cents: 0.5, usd: 620 })).toBe("0.5¢ $620");
  });
  it("hover readout and aria-label", () => {
    const r = readout(book, "YES", 1200)!;
    expect(r.startsWith("$1,200 → avg 0.4")).toBe(true);
    expect(r).toMatch(/slip \+\d+\.\d¢$/);
    expect(readout(book, "YES", 1e9)).toBeNull();
    const c = curveOf(book, "YES");
    expect(ariaLabel("YES", c)).toMatch(/^Slippage curve, YES, capacity at 1¢ \$[\d,k]+$/);
    expect(ariaLabel("NO", null)).toBe("Slippage curve, NO");
  });
});

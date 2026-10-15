import { describe, expect, it } from "vitest";
import { feeRateFor, takerFeePerShare } from "./fees";

describe("fees", () => {
  it("fee = rate*p*(1-p)", () => {
    expect(takerFeePerShare(0.04, 0.5)).toBeCloseTo(0.01, 12);
    expect(takerFeePerShare(0.07, 0.2)).toBeCloseTo(0.0112, 12);
  });
  it("is zero at the extremes and for rate 0", () => {
    expect(takerFeePerShare(0.04, 0)).toBe(0);
    expect(takerFeePerShare(0.04, 1)).toBe(0);
    expect(takerFeePerShare(0, 0.5)).toBe(0);
  });
  it("rejects bad input", () => {
    expect(() => takerFeePerShare(-0.1, 0.5)).toThrow(RangeError);
    expect(() => takerFeePerShare(0.04, 1.1)).toThrow(RangeError);
    expect(() => takerFeePerShare(NaN, 0.5)).toThrow(RangeError);
  });
  it("feeRateFor prefers the market rate, else flags the category fallback", () => {
    expect(feeRateFor("Crypto", 0.05)).toEqual({ rate: 0.05, fallback: false });
    expect(feeRateFor("Crypto", null)).toEqual({ rate: 0.07, fallback: true });
    expect(feeRateFor("Geopolitics", null)).toEqual({ rate: 0, fallback: true });
    expect(feeRateFor("Politics", null)).toEqual({ rate: 0.04, fallback: true });
    expect(feeRateFor("weird", null)).toEqual({ rate: 0.04, fallback: true });
  });
});

import { describe, expect, it } from "vitest";
import { aggregate, brier, confidenceForCategory, logLoss, reliabilityBins } from "./calibration";
import type { Forecast } from "./types";

const f = (p: number, pMarket: number, outcome: 0 | 1, category = "x"): Forecast => ({
  p, pMarket, outcome, category, model: "m", roleMix: "r",
});

describe("brier / logLoss", () => {
  it("brier", () => {
    expect(brier(0.7, 1)).toBeCloseTo(0.09, 10);
    expect(brier(0.7, 0)).toBeCloseTo(0.49, 10);
  });
  it("logLoss = -ln(p) when outcome 1", () => {
    expect(logLoss(0.8, 1)).toBeCloseTo(0.2231435513, 9);
    expect(logLoss(0.8, 0)).toBeCloseTo(-Math.log(0.2), 9);
  });
  it("logLoss clamps 0/1", () => {
    expect(logLoss(0, 1)).toBeCloseTo(-Math.log(1e-6), 9);
    expect(Number.isFinite(logLoss(1, 0))).toBe(true);
  });
});

describe("aggregate", () => {
  it("groups by key with model and market brier", () => {
    const rows = [f(0.8, 0.6, 1, "a"), f(0.4, 0.5, 0, "a"), f(0.5, 0.5, 1, "b")];
    const out = aggregate(rows, (r) => r.category);
    expect(out.a?.n).toBe(2);
    expect(out.a?.brier).toBeCloseTo(0.1, 10); // (0.04+0.16)/2
    expect(out.a?.marketBrier).toBeCloseTo(0.205, 10); // (0.16+0.25)/2
    expect(out.b?.brier).toBeCloseTo(0.25, 10);
    expect(out.a?.logLoss).toBeCloseTo((-Math.log(0.8) - Math.log(0.6)) / 2, 9);
  });
});

describe("reliabilityBins", () => {
  it("returns 10 bins; p=1 lands in last bin", () => {
    const bins = reliabilityBins([f(0.05, 0.5, 0), f(0.08, 0.5, 1), f(1, 0.5, 1)]);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({ n: 2, observed: 0.5 });
    expect(bins[0]?.meanPredicted).toBeCloseTo(0.065, 10);
    expect(bins[9]).toMatchObject({ n: 1, meanPredicted: 1, observed: 1 });
    expect(bins[4]).toMatchObject({ n: 0, meanPredicted: null, observed: null });
  });
});

describe("confidenceForCategory", () => {
  it("capped at 0.4 below 30 resolved, whatever the skill", () => {
    expect(confidenceForCategory(29, 0.1, 0.25)).toBe(0.4);
  });
  it("maps skill 0.05 -> 0.9, 0.025 -> 0.65, <=0 -> 0.4, clamps above", () => {
    expect(confidenceForCategory(30, 0.2, 0.25)).toBeCloseTo(0.9, 10);
    expect(confidenceForCategory(30, 0.225, 0.25)).toBeCloseTo(0.65, 10);
    expect(confidenceForCategory(30, 0.3, 0.25)).toBe(0.4);
    expect(confidenceForCategory(100, 0.05, 0.25)).toBeCloseTo(0.9, 10);
  });
});

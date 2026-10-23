import type { Forecast, Outcome } from "./types";

export const brier = (p: number, outcome: Outcome): number => (p - outcome) ** 2;

export function logLoss(p: number, outcome: Outcome, eps = 1e-6): number {
  const q = Math.min(1 - eps, Math.max(eps, p));
  return -(outcome ? Math.log(q) : Math.log(1 - q));
}

export interface Agg {
  n: number;
  brier: number;
  logLoss: number;
  marketBrier: number;
}

/** Mean Brier / log loss / market Brier per key (category, model, role mix, ...). */
export function aggregate(rows: Forecast[], key: (r: Forecast) => string): Record<string, Agg> {
  const sums: Record<string, Agg> = {};
  for (const r of rows) {
    const a = (sums[key(r)] ??= { n: 0, brier: 0, logLoss: 0, marketBrier: 0 });
    a.n++;
    a.brier += brier(r.p, r.outcome);
    a.logLoss += logLoss(r.p, r.outcome);
    a.marketBrier += brier(r.pMarket, r.outcome);
  }
  for (const a of Object.values(sums)) {
    a.brier /= a.n;
    a.logLoss /= a.n;
    a.marketBrier /= a.n;
  }
  return sums;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
}

export function reliabilityBins(rows: Forecast[]): Bin[] {
  const bins: Bin[] = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, meanPredicted: null, observed: null }));
  const acc = bins.map(() => ({ p: 0, o: 0 }));
  for (const r of rows) {
    const i = Math.min(9, Math.floor(r.p * 10));
    bins[i]!.n++;
    acc[i]!.p += r.p;
    acc[i]!.o += r.outcome;
  }
  bins.forEach((b, i) => {
    if (b.n) {
      b.meanPredicted = acc[i]!.p / b.n;
      b.observed = acc[i]!.o / b.n;
    }
  });
  return bins;
}

/**
 * Confidence c for a category.
 * ponytail: linear map, skill = marketBrier - brier (positive = beats the crowd).
 * c = 0.4 + 0.5 * clamp(skill / 0.05, 0, 1): no/negative skill -> 0.4, a 0.05 Brier edge -> 0.9.
 * 0.05 is a guess; tune it from the calibration job. Below 30 resolved c is pinned at 0.4 (SPEC).
 */
export function confidenceForCategory(nResolved: number, modelBrier: number, marketBrier: number): number {
  if (nResolved < 30) return 0.4;
  const skill = marketBrier - modelBrier;
  return 0.4 + 0.5 * Math.min(1, Math.max(0, skill / 0.05));
}

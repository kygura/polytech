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

/** The longshot band: the cheap side of the market priced 3-20%, where crowds overpay for the dramatic outcome. */
export const LONGSHOT_BAND = [0.03, 0.2] as const;
export const FADE_GATE_N = 30;

/** A fade: the market's cheap side sits in the longshot band and our estimate puts it lower still (the status quo is the bet). */
export function isFade(pMarket: number, p: number): boolean {
  const yesCheap = pMarket < 0.5, cheap = yesCheap ? pMarket : 1 - pMarket, ours = yesCheap ? p : 1 - p;
  return cheap >= LONGSHOT_BAND[0] && cheap <= LONGSHOT_BAND[1] && ours < cheap;
}

export interface FadeCalib {
  n: number;
  /** Mean longshot price at thesis time, our mean estimate of it, and how often it actually happened. */
  marketP: number | null; ourP: number | null; hitRate: number | null;
  brier: number | null; marketBrier: number | null;
  /** Brier skill vs the market, 1 - ours/market's: Brier is tiny near the tails, so the category's fixed 0.05 scale never moves. */
  skill: number | null;
  /** Confidence for new fades: 0.4 below FADE_GATE_N resolved, then 0.4 + 0.5·clamp(skill / 0.2). */
  c: number;
}

/**
 * Pooled across categories (the bias is not category-specific, and no single category reaches 30 tail markets soon).
 * ponytail: skill 0.2 -> 0.9 is a guess; a market at 10% that truly resolves 3% of the time scores ~0.15 for a 3% estimate.
 */
export function fadeCalibration(rows: Forecast[]): FadeCalib {
  const f = rows.filter((r) => isFade(r.pMarket, r.p));
  const n = f.length;
  if (!n) return { n, marketP: null, ourP: null, hitRate: null, brier: null, marketBrier: null, skill: null, c: 0.4 };
  // in the cheap side's terms: its price, our estimate, whether it happened
  const cheap = f.map((r) => (r.pMarket < 0.5 ? { m: r.pMarket, p: r.p, o: r.outcome } : { m: 1 - r.pMarket, p: 1 - r.p, o: 1 - r.outcome }));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const b = mean(f.map((r) => brier(r.p, r.outcome))), mb = mean(f.map((r) => brier(r.pMarket, r.outcome)));
  const skill = mb > 0 ? 1 - b / mb : null;
  return {
    n, marketP: mean(cheap.map((x) => x.m)), ourP: mean(cheap.map((x) => x.p)), hitRate: mean(cheap.map((x) => x.o)), brier: b, marketBrier: mb, skill,
    c: n < FADE_GATE_N || skill == null ? 0.4 : 0.4 + 0.5 * Math.min(1, Math.max(0, skill / 0.2)),
  };
}

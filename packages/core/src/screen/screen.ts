import type { Market, ScreenResult, Settings, Side, Snapshot, Tier } from "../types";
import { depthWithin, midOf, sortAsc } from "./book";

const DAY = 86_400_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export type Pass1Reason =
  | "closed" | "not_accepting" | "disputed" | "days_out_of_range"
  | "excluded_category" | "no_book" | "thin_depth" | "no_headroom";

export function pass1(
  m: Market, snap: Snapshot, s: Settings, now: number,
): { ok: true } | { ok: false; reason: Pass1Reason } {
  const f = s.filters;
  const no = (reason: Pass1Reason) => ({ ok: false, reason }) as const;
  if (!m.open) return no("closed");
  if (!m.acceptingOrders) return no("not_accepting");
  if (m.inDispute) return no("disputed");
  const days = (m.endDate - now) / DAY;
  if (days < f.minDays || days > f.maxDays) return no("days_out_of_range");
  const ex = new Set(f.excludedCategories.map((x) => x.toLowerCase()));
  if ([m.category, ...m.tags].some((t) => ex.has(t.toLowerCase()))) return no("excluded_category");
  const mid = midOf(snap.bids, snap.asks);
  if (mid == null) return no("no_book");
  // within minEdge of 0 or 1 the cheap side cannot pay minEdge even if it is certain, and the other side needs a fair value
  // at least double the market's: sub-cent tail precision is noise, not an edge, so such markets are never researched on their own
  if (Math.min(mid, 1 - mid) < s.minEdge) return no("no_headroom");
  // ponytail: side traded is unknown at pass 1, so either side's depth qualifies
  const depth = Math.max(depthWithin(snap.asks, mid, f.depthCents), depthWithin(snap.bids, mid, f.depthCents));
  return depth >= f.minDepthUsd ? { ok: true } : no("thin_depth");
}

/** Inefficiency: mean of spread, staleness, round-number pinning, longshot zone. Heuristic constants. */
export function factorI(snap: Snapshot, now: number): number {
  const mid = midOf(snap.bids, snap.asks);
  if (mid == null) return 0;
  const bid = Math.max(...snap.bids.map((l) => l.price));
  const ask = Math.min(...snap.asks.map((l) => l.price));
  const spread = clamp01((ask - bid) / 0.1);
  const stale = snap.flowUnknown ? 0 : snap.lastTradeTs == null ? 1 : clamp01((now - snap.lastTradeTs) / 3600_000 / 48);
  const pinned = Math.abs(mid - Math.round(mid / 0.05) * 0.05) <= 0.005 + 1e-9 ? 1 : 0;
  const longshot = mid < 0.07 || mid > 0.93 ? 1 : 0;
  return (spread + stale + pinned + longshot) / 4;
}

/** Liquidity fit vs the two size targets; tier = size if the big target is at least half fillable. */
export function factorL(snap: Snapshot, s: Settings): { L: number; tier: Tier } {
  const asks = sortAsc(snap.asks);
  if (!asks.length) return { L: 0, tier: "small-cap" };
  const limit = asks[0]!.price + s.slippageCents / 100 + 1e-9;
  const fillable = asks.filter((l) => l.price <= limit).reduce((t, l) => t + l.price * l.size, 0);
  const big = clamp01(fillable / s.sizeTargets.size);
  return big >= 0.5
    ? { L: big, tier: "size" }
    : { L: clamp01(fillable / s.sizeTargets.smallCap), tier: "small-cap" };
}

/** Time value: full credit to tDecayDays, then tDecayDays/d. */
export function factorT(days: number, s: Settings): number {
  if (!(days > 0)) return 0;
  return days <= s.tDecayDays ? 1 : s.tDecayDays / days;
}

/** 24h volume up to which a market counts as quiet: full attention credit. */
export const QUIET_VOL_USD = 5_000;
const A_FLOOR = 0.3;

/**
 * Attention: the desk's edge is diligence, and it is widest where few participants have done the work. Quiet markets
 * (<= QUIET_VOL_USD a day) score 1; each 10x more volume takes 0.35 off, floored at 0.3, so a $50k/day market scores 0.65 and a
 * $500k+ headline market 0.3: ranked behind, never excluded. Liquidity (factorL) still requires a fillable book.
 */
export function factorA(snap: Pick<Snapshot, "vol24h">): number {
  const v = Number.isFinite(snap.vol24h) ? Math.max(0, snap.vol24h) : 0;
  return v <= QUIET_VOL_USD ? 1 : Math.max(A_FLOOR, 1 - 0.35 * Math.log10(v / QUIET_VOL_USD));
}

/**
 * Rules nuance: markets whose rules need careful reading are where headline traders misprice, and the research pod resolves
 * the ambiguity with its strongest model (rules reader). 1 + 0.5 x the classifier's rule_ambiguity (0..1); unrated -> 1.
 * Outright unsettleable rules are already penalised through R.
 */
export function factorN(ambiguity: number | null | undefined): number {
  return typeof ambiguity === "number" && Number.isFinite(ambiguity) ? 1 + 0.5 * Math.min(1, Math.max(0, ambiguity)) : 1;
}

export type CrowdInput = { top10Share: number; netFlow: number; skew: number }; // flow, skew in -1..1

export function crowd(i: CrowdInput): { c: number; side: Side | null } {
  const c = clamp01((clamp01(i.top10Share) + Math.min(1, Math.abs(i.netFlow)) + Math.min(1, Math.abs(i.skew))) / 3);
  const lean = i.netFlow + i.skew;
  return { c, side: lean > 0.25 ? "YES" : lean < -0.25 ? "NO" : null };
}

/** A and N default to 1 (neutral) for callers that score without a snapshot or a rules rating. */
export function priority(f: { R: number; I: number; L: number; T: number; C: number; A?: number; N?: number }, s: Settings): number {
  return f.R * f.I * f.L * f.T * (1 + s.cCoef * f.C) * (f.A ?? 1) * (f.N ?? 1);
}

export function screen(a: {
  market: Market; snap: Snapshot; R: number; crowd: CrowdInput; structural: boolean; settings: Settings; now: number;
  /** The R classifier's rule_ambiguity (0..1); omit when unrated. */
  ambiguity?: number | null;
}): ScreenResult {
  const { market, snap, settings, now } = a;
  const I = factorI(snap, now);
  const { L, tier } = factorL(snap, settings);
  const T = factorT((market.endDate - now) / DAY, settings);
  const C = crowd(a.crowd).c;
  const A = factorA(snap), N = factorN(a.ambiguity);
  return {
    conditionId: market.conditionId, ts: now, R: a.R, I, L, T, C, A, N,
    priority: priority({ R: a.R, I, L, T, C, A, N }, settings), tier, structural: a.structural,
  };
}

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

export type CrowdInput = { top10Share: number; netFlow: number; skew: number }; // flow, skew in -1..1

export function crowd(i: CrowdInput): { c: number; side: Side | null } {
  const c = clamp01((clamp01(i.top10Share) + Math.min(1, Math.abs(i.netFlow)) + Math.min(1, Math.abs(i.skew))) / 3);
  const lean = i.netFlow + i.skew;
  return { c, side: lean > 0.25 ? "YES" : lean < -0.25 ? "NO" : null };
}

export function priority(f: { R: number; I: number; L: number; T: number; C: number }, s: Settings): number {
  return f.R * f.I * f.L * f.T * (1 + s.cCoef * f.C);
}

export function screen(a: {
  market: Market; snap: Snapshot; R: number; crowd: CrowdInput; structural: boolean; settings: Settings; now: number;
}): ScreenResult {
  const { market, snap, settings, now } = a;
  const I = factorI(snap, now);
  const { L, tier } = factorL(snap, settings);
  const T = factorT((market.endDate - now) / DAY, settings);
  const C = crowd(a.crowd).c;
  return {
    conditionId: market.conditionId, ts: now, R: a.R, I, L, T, C,
    priority: priority({ R: a.R, I, L, T, C }, settings), tier, structural: a.structural,
  };
}

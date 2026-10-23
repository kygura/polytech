import { feeExponentOf, takerFeePerShare } from "./fees";
import { complementBook, exitDepth, sortAsc } from "./screen/book";
import type { Level, Settings, Side, WatchCore } from "./types";

export type SizeInput = {
  bids: Level[]; // YES-token book
  asks: Level[];
  pMid: number; // YES mid
  pHat: number; // fair YES probability
  c: number; // confidence 0..1
  daysLeft: number;
  feeRate: number;
  /** Gamma feeSchedule.exponent; omit/null = 1. */
  feeExponent?: number | null;
  crowdC: number; // 0..1
  crowdSide: Side | null;
  settings: Settings;
  /** Signed 24h taker flow in YES terms (buy YES / sell NO positive). Omit/null: no contrarian flag. */
  flow24h?: number | null;
  /** Log-odds multiplier on pHat before the blend; falls back to settings.extremize, then 1 (no-op). */
  extremize?: number;
};

/** WatchCore plus the Rev 7 fields. Callers typed to WatchCore keep working. */
export type SizeResult = WatchCore & {
  exitFactor: number; // 0.5 (hold to resolution) .. 1 (bids absorb the stake); 0.75 when unknown
  contrarian: boolean; // model disagrees with both the mid and the 24h flow
};

const MIN_ORDER_USD = 1; // dust below the exchange minimum is not an order
/**
 * Below this all-in price a buy is a lottery ticket: the crowd already overpays longshots (favourite-longshot bias) and a
 * model cannot calibrate tail odds, so the edge must be at least the price itself (fair >= 2x cost), not just minEdge.
 * The expensive side of the same market (NO at 90c+ against an overpriced YES) keeps the plain minEdge rule.
 */
export const LONGSHOT_K = 0.15;
/** Edge a buy at all-in price `k` must clear. */
export const needEdge = (k: number, minEdge: number) => (k < LONGSHOT_K ? Math.max(minEdge, k) : minEdge);

const inUnit = (name: string, x: number) => {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`${name} must be in [0,1], got ${x}`);
};

/** 0.5 (forced hold-to-resolution) .. 1 (bid depth absorbs the stake). Unknown depth = neutral 0.75. */
export function exitFactor(exitDepthUsd: number | null | undefined, stake: number): number {
  if (!(stake > 0)) return 1;
  if (typeof exitDepthUsd !== "number" || !Number.isFinite(exitDepthUsd)) return 0.75;
  return 0.5 + 0.5 * Math.min(1, Math.max(0, exitDepthUsd) / stake);
}

/** p^k / (p^k + (1-p)^k): extremize in logit space. k = 1 is the identity. */
export function extremizeP(p: number, k: number): number {
  if (k === 1 || !(k > 0) || !Number.isFinite(k)) return p;
  if (p <= 0 || p >= 1) return p;
  return 1 / (1 + Math.exp(-k * Math.log(p / (1 - p))));
}

/**
 * All-in price per share filling `usd` of asks cheapest-first: (usd + Σ per-level fee) / shares, the taker fee charged
 * level by level at that level's price. usd <= 0 -> best ask incl. fee. Null if the book cannot absorb it.
 */
export function allInPrice(asks: Level[], usd: number, feeRate: number, feeExponent = 1): number | null {
  const ls = sortAsc(asks);
  if (!ls.length) return null;
  if (usd <= 0) return ls[0]!.price + takerFeePerShare(feeRate, ls[0]!.price, feeExponent);
  let left = usd, shares = 0, fees = 0;
  for (const l of ls) {
    const cost = l.price * l.size;
    const take = left <= cost + 1e-9 ? left / l.price : l.size;
    shares += take;
    fees += take * takerFeePerShare(feeRate, l.price, feeExponent);
    left -= Math.min(left, cost);
    if (left <= 1e-9) return (usd + fees) / shares;
  }
  return null;
}

function evalSide(side: Side, a: SizeInput, pHatYes: number): SizeResult | null {
  const { settings: s, feeRate, daysLeft: d } = a;
  const book = side === "YES" ? { bids: a.bids, asks: a.asks } : complementBook({ bids: a.bids, asks: a.asks });
  const asks = book.asks;
  const pHat = side === "YES" ? pHatYes : 1 - pHatYes;
  const pMid = side === "YES" ? a.pMid : 1 - a.pMid;
  const pPost = a.c * pHat + (1 - a.c) * pMid;
  const kAt = (usd: number) => allInPrice(asks, usd, feeRate, feeExponentOf(a.feeExponent));
  const k0 = kAt(0);
  if (k0 == null) return null;

  const B = s.bankroll;
  const fStar = Math.max(0, (pPost - k0) / (1 - k0));
  const depth = sortAsc(asks).reduce((t, l) => t + l.price * l.size, 0);
  const hi = Math.min(s.kelly * fStar * B, s.capFrac * B, depth);
  const ok = (usd: number) => {
    const k = kAt(usd);
    return k != null && pPost - k >= needEdge(k, s.minEdge);
  };
  let sizeUsd = 0;
  if (hi > 0 && ok(0)) {
    if (ok(hi)) sizeUsd = hi;
    else {
      // e(S) falls as S climbs the book: bisect for the largest S with e >= needEdge
      let lo = 0, up = hi;
      for (let i = 0; i < 60; i++) {
        const m = (lo + up) / 2;
        if (ok(m)) lo = m; else up = m;
      }
      sizeUsd = lo;
    }
  }

  if (sizeUsd < MIN_ORDER_USD) sizeUsd = 0;

  const k = kAt(sizeUsd)!;
  const e = pPost - k;
  const r = e / k;
  const shares = sizeUsd > 0 ? sharesFor(asks, sizeUsd) : 0;
  const against = a.crowdSide != null && a.crowdSide !== side ? a.crowdC : 0;
  const ef = exitFactor(exitDepth(book), sizeUsd);
  const dir = Math.sign(pHatYes - a.pMid), flow = Math.sign(a.flow24h ?? 0);
  const contrarian = dir !== 0 && flow !== 0 && dir !== flow;
  return {
    side, pMid, pHat, c: a.c, pPost, k, e, edgeC: e * 100, r,
    payoff: (1 - k) / k,
    rAnn: Math.min(s.rAnnCap, (1 + r) ** (365 / d) - 1),
    sizeUsd, shares,
    expectedProfit: sizeUsd > 0 ? shares * e : 0,
    daysLeft: d,
    rank: sizeUsd > 0 ? ((e * sizeUsd) / d) * (1 + s.crowdBonus * against) * ef : 0,
    exitFactor: ef,
    contrarian,
  };
}

/** Shares bought spending `usd` up the ask ladder (book known to absorb it). */
function sharesFor(asks: Level[], usd: number): number {
  let left = usd, shares = 0;
  for (const l of sortAsc(asks)) {
    const cost = l.price * l.size;
    if (left <= cost + 1e-9) return shares + left / l.price;
    left -= cost;
    shares += l.size;
  }
  return shares;
}

/**
 * Best-side sizing row against the real book and fees: both sides are evaluated (NO via the complement book) and the one
 * with more edge wins; the judge's side is checked by the caller. null if d<=0 or neither side has asks.
 */
export function sizeTrade(a: SizeInput): SizeResult | null {
  inUnit("pHat", a.pHat);
  inUnit("pMid", a.pMid);
  inUnit("c", a.c);
  inUnit("crowdC", a.crowdC);
  if (!(a.daysLeft > 0)) return null;
  const pHatYes = extremizeP(a.pHat, a.extremize ?? (a.settings as { extremize?: number }).extremize ?? 1);
  const rows = [evalSide("YES", a, pHatYes), evalSide("NO", a, pHatYes)].filter((r): r is SizeResult => r != null);
  return rows.reduce<SizeResult | null>((best, r) => (best && best.e >= r.e ? best : r), null);
}

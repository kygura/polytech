import { takerFeePerShare } from "./fees";
import { mirror, sortAsc, vwapForUsd } from "./screen/book";
import type { Level, Settings, Side, WatchCore } from "./types";

export type SizeInput = {
  bids: Level[]; // YES-token book
  asks: Level[];
  pMid: number; // YES mid
  pHat: number; // fair YES probability
  c: number; // confidence 0..1
  daysLeft: number;
  feeRate: number;
  crowdC: number; // 0..1
  crowdSide: Side | null;
  settings: Settings;
};

const MIN_ORDER_USD = 1; // dust below the exchange minimum is not an order

const inUnit = (name: string, x: number) => {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`${name} must be in [0,1], got ${x}`);
};

function evalSide(side: Side, a: SizeInput): WatchCore | null {
  const { settings: s, feeRate, daysLeft: d } = a;
  const asks = side === "YES" ? a.asks : mirror(a.bids);
  const pHat = side === "YES" ? a.pHat : 1 - a.pHat;
  const pMid = side === "YES" ? a.pMid : 1 - a.pMid;
  const pPost = a.c * pHat + (1 - a.c) * pMid;
  const kAt = (usd: number) => {
    const v = vwapForUsd(asks, usd);
    return v == null ? null : v + takerFeePerShare(feeRate, v);
  };
  const k0 = kAt(0);
  if (k0 == null) return null;

  const B = s.bankroll;
  const fStar = Math.max(0, (pPost - k0) / (1 - k0));
  const depth = sortAsc(asks).reduce((t, l) => t + l.price * l.size, 0);
  const hi = Math.min(s.kelly * fStar * B, s.capFrac * B, depth);
  const ok = (usd: number) => {
    const k = kAt(usd);
    return k != null && pPost - k >= s.minEdge;
  };
  let sizeUsd = 0;
  if (hi > 0 && ok(0)) {
    if (ok(hi)) sizeUsd = hi;
    else {
      // e(S) falls as S climbs the book: bisect for the largest S with e >= minEdge
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
  const vwap = vwapForUsd(asks, sizeUsd)!;
  const shares = sizeUsd / vwap;
  const against = a.crowdSide != null && a.crowdSide !== side ? a.crowdC : 0;
  return {
    side, pMid, pHat, c: a.c, pPost, k, e, edgeC: e * 100, r,
    payoff: (1 - k) / k,
    rAnn: Math.min(s.rAnnCap, (1 + r) ** (365 / d) - 1),
    sizeUsd, shares,
    expectedProfit: sizeUsd > 0 ? shares * e : 0,
    daysLeft: d,
    rank: sizeUsd > 0 ? ((e * sizeUsd) / d) * (1 + s.crowdBonus * against) : 0,
  };
}

/** Best-side sizing row against the real book and fees. null if d<=0 or neither side has asks. */
export function sizeTrade(a: SizeInput): WatchCore | null {
  inUnit("pHat", a.pHat);
  inUnit("pMid", a.pMid);
  inUnit("c", a.c);
  inUnit("crowdC", a.crowdC);
  if (!(a.daysLeft > 0)) return null;
  const rows = [evalSide("YES", a), evalSide("NO", a)].filter((r): r is WatchCore => r != null);
  return rows.reduce<WatchCore | null>((best, r) => (best && best.e >= r.e ? best : r), null);
}

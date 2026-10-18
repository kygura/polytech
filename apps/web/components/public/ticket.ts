// Pure TradeTicket math: prefill from the public detail, the quote lines, field validation. No React, no network.
import { crowd, DEFAULT_SETTINGS, livelimitPrice, mirror, sizeTrade, takerFeePerShare, vwapForUsd, type Side } from "@pm/core";
import type { PublicMarketDetail } from "../../lib/public";

export const TICK = 0.01; // ponytail: tick size is not stored server-side (public.ts); 0.01 is the common tick, 0.001 markets get a coarser limit
const SHARE_STEP = 100; // shares rounded down to 0.01 so the cost never exceeds the amount

export type Prefill = { side: Side; price: number | null; amount: number | null };

/** Asks of the token bought for `side`, from the YES book. */
export const sideAsks = (d: PublicMarketDetail, side: Side) => (!d.snapshot ? [] : side === "YES" ? d.snapshot.asks : mirror(d.snapshot.bids));
export const bestAsk = (d: PublicMarketDetail, side: Side) => vwapForUsd(sideAsks(d, side), 0);

/**
 * Thesis side; limit = livelimitPrice on that side's book (vwap of the sized order, or the best ask); amount = sizeTrade
 * with bankroll = balance and default settings. No thesis: YES at the best ask, no amount. No edge at the limit: best ask, no amount.
 */
export function prefill(d: PublicMarketDetail, balance: number | null): Prefill {
  const t = d.thesis, s = d.snapshot;
  const side: Side = t?.side ?? "YES";
  const best = bestAsk(d, side);
  if (!t || !s || best == null) return { side, price: best, amount: null };
  let sized: ReturnType<typeof sizeTrade> = null;
  if (balance != null && balance > 0 && s.mid != null && t.pYes != null) {
    const cr = crowd({ top10Share: s.top10Share ?? 0, netFlow: s.netFlow, skew: 0 });
    try {
      sized = sizeTrade({
        bids: s.bids, asks: s.asks, pMid: s.mid, pHat: t.pYes, c: t.c, daysLeft: d.market.daysLeft, feeRate: d.market.feeRate,
        crowdC: cr.c, crowdSide: cr.side, settings: { ...DEFAULT_SETTINGS, bankroll: balance },
      });
    } catch { sized = null; } // out-of-range input: no size suggestion
    if (sized && (sized.side !== side || !(sized.sizeUsd > 0))) sized = null;
  }
  const limit = livelimitPrice({ vwap: sized ? sized.sizeUsd / sized.shares : best, pPost: sized?.pPost ?? t.pPost, tick: TICK });
  if (limit == null) return { side, price: best, amount: null };
  return { side, price: limit, amount: sized ? Math.floor(sized.sizeUsd * 100) / 100 : null };
}

export type Quote = { shares: number; cost: number; fee: number; maxLoss: number; payout: number };

/** Buy `amount` USD at limit `price`: shares rounded down to 0.01; fee = taker fee (an upper bound: a resting maker fill pays none). */
export function quote(price: number, amount: number, feeRate: number): Quote | null {
  if (!(price > 0 && price < 1) || !(amount > 0)) return null;
  const shares = Math.floor((amount / price) * SHARE_STEP) / SHARE_STEP;
  if (!(shares > 0)) return null;
  const cost = shares * price, fee = takerFeePerShare(feeRate, price) * shares;
  return { shares, cost, fee, maxLoss: cost + fee, payout: shares };
}

export type FieldErrors = { price?: string; amount?: string };

export function validate(price: number | null, amount: number | null, balance: number | null, q: Quote | null): FieldErrors {
  const e: FieldErrors = {};
  if (price == null || !(price >= 0.001 && price <= 0.999)) e.price = "Price must be between 0.001 and 0.999";
  if (amount == null || !(amount > 0)) e.amount = "Enter an amount";
  else if (!q) e.amount = "Amount is too small for one share step";
  else if (balance != null && q.maxLoss > balance) e.amount = "Amount exceeds your balance";
  return e;
}

export type Gate = "disconnected" | "wrong_network" | "geo_checking" | "geo_blocked" | "geo_failed" | "creds_needed" | "allowance_checking" | "allowance_needed";
type GateIn = { wallet: "unavailable" | "disconnected" | "connecting" | "connected"; chainOk: boolean; region: "idle" | "checking" | "ok" | "blocked" | "failed"; credsReady: boolean; approved: boolean | null };

/** First unmet precondition, in DESIGN 10.4 order; null = ready to trade. Region fails closed: anything but "ok" blocks. */
export function ticketGate(s: GateIn): Gate | null {
  if (s.wallet !== "connected") return "disconnected";
  if (!s.chainOk) return "wrong_network";
  if (s.region === "blocked") return "geo_blocked";
  if (s.region === "failed") return "geo_failed";
  if (s.region !== "ok") return "geo_checking";
  if (!s.credsReady) return "creds_needed";
  if (s.approved == null) return "allowance_checking";
  return s.approved ? null : "allowance_needed";
}

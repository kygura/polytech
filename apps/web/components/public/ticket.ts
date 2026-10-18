// Pure TradeTicket math: prefill from the public detail, the quote lines, field validation. No React, no network.
import { crowd, DEFAULT_SETTINGS, livelimitPrice, mirror, sizeTrade, takerFeePerShare, vwapForUsd, type Side } from "@pm/core";
import type { ClobExchange, LimitOrder } from "@pm/pm/exchange";
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

/** Limit rounded DOWN to the tick: a buy never pays more than typed, and the venue rejects off-tick prices. */
export const onTick = (p: number, tick = TICK) => Math.round(Math.floor(p / tick + 1e-9) * tick * 1e6) / 1e6;

export type Quote = { shares: number; cost: number; fee: number; maxLoss: number; payout: number };

/** Buy `amount` USD at limit `price`: shares rounded down to 0.01; fee = taker fee (an upper bound: a resting maker fill pays none). */
export function quote(rawPrice: number, amount: number, feeRate: number): Quote | null {
  const price = onTick(rawPrice);
  if (!(price > 0 && price < 1) || !(amount > 0)) return null;
  const shares = Math.floor((amount / price) * SHARE_STEP) / SHARE_STEP;
  if (!(shares > 0)) return null;
  const cost = shares * price, fee = takerFeePerShare(feeRate, price) * shares;
  return { shares, cost, fee, maxLoss: cost + fee, payout: shares };
}

export type FieldErrors = { price?: string; amount?: string };

export function validate(price: number | null, amount: number | null, balance: number | null, q: Quote | null): FieldErrors {
  const e: FieldErrors = {};
  if (price == null || !(onTick(price) >= TICK && onTick(price) <= 1 - TICK)) e.price = `Price must be between ${TICK} and ${1 - TICK}`;
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

type Placer = Pick<ClobExchange, "place" | "openOrders" | "trades">;
export type PlaceResult = { kind: "open"; orderId: string } | { kind: "filled"; shares: number; avg: number; fee: number } | { kind: "rejected"; error: string } | { kind: "declined" } | { kind: "unknown" };

/**
 * Places once. A throw that is not a wallet rejection is an UNKNOWN outcome (the order may have reached the venue, see Exchange.placeImmediate):
 * look the order up instead of letting the visitor resend it blind.
 */
export async function placeTicketOrder(ex: Placer, o: LimitOrder, isRejection: (e: unknown) => boolean, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<PlaceResult> {
  const since = Date.now();
  try {
    const r = await ex.place(o);
    return r.status === "rejected" ? { kind: "rejected", error: r.error ?? "rejected by Polymarket" } : { kind: "open", orderId: r.orderId };
  } catch (e) {
    if (isRejection(e)) return { kind: "declined" };
    for (let i = 0; ; i++) {
      const r = await findPlaced(ex, o, since);
      if (r.kind !== "unknown" || i >= LAG_TRIES - 1) return r;
      await wait(LAG_MS);
    }
  }
}

/**
 * Same token, side, price and size among the open orders; else a fill of it among the trades since the send started (an order that
 * filled on arrival is no longer open). ponytail: OpenOrder and trades carry no order match beyond the fields, so an older identical order also matches.
 */
// Err wide: a missed real fill reads as `unknown` and invites a resend (double exposure); a false `filled` only misreports until the
// positions refresh. Same 60s window as the ticket's order-status check.
const SKEW_MS = 60_000;
const LAG_TRIES = 3, LAG_MS = 5_000; // the venue's trade index can trail the match: up to 3 lookups 5s apart (~10s) before saying unknown
// a limit fills at the resting maker's price: at or below the limit for BUY, at or above for SELL
const atOrBetter = (p: number, o: LimitOrder) => (o.side === "BUY" ? p <= o.price + 1e-9 : p >= o.price - 1e-9);

export async function findPlaced(ex: Pick<ClobExchange, "openOrders" | "trades">, o: LimitOrder, since: number): Promise<PlaceResult> {
  try {
    const m = (await ex.openOrders()).find((x) => x.tokenId === o.tokenId && x.side === o.side && Math.abs(x.price - o.price) < 1e-9 && Math.abs(x.shares - o.shares) < 1e-6);
    if (m) return { kind: "open", orderId: m.orderId };
    const fills = (await ex.trades(new Date(since - SKEW_MS))).filter((t) => t.tokenId === o.tokenId && t.side === o.side && atOrBetter(t.price, o));
    const sh = fills.reduce((a, t) => a + t.shares, 0);
    if (!(sh >= o.shares - 0.005)) return { kind: "unknown" };
    return { kind: "filled", shares: sh, avg: fills.reduce((a, t) => a + t.shares * t.price, 0) / sh, fee: fills.reduce((a, t) => a + t.fee, 0) };
  } catch {
    return { kind: "unknown" };
  }
}

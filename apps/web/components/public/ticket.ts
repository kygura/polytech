// Pure ticket math: tick rounding, the quote lines, field validation, the gate, the send. No React, no network.
import { takerFeePerShare, type Side } from "@pm/core";
import type { ClobExchange, LimitOrder } from "@pm/pm/exchange";

export const DEFAULT_TICK = 0.01; // used until the live book states the tick
const SHARE_STEP = 100; // shares rounded down to 0.01 so the cost never exceeds the amount

/** Decimals needed to print a price on this tick (0.01 -> 2, 0.001 -> 3, 0.0001 -> 4). */
export const tickDecimals = (tick: number) => Math.max(0, Math.min(8, Math.ceil(-Math.log10(tick) - 1e-9)));

/** Limit rounded DOWN to the tick: a buy never pays more than typed, and the venue rejects off-tick prices. */
export const onTick = (p: number, tick: number) => Math.round(Math.floor(p / tick + 1e-9) * tick * 1e6) / 1e6;

/** Limit rounded UP to the tick: a sell never goes below the typed price. */
export const onTickUp = (p: number, tick: number) => Math.round(Math.ceil(p / tick - 1e-9) * tick * 1e6) / 1e6;
/** Side-aware: BUY rounds down, SELL rounds up. An on-tick price is unchanged. */
export const roundTick = (side: "BUY" | "SELL", p: number, tick: number) => (side === "SELL" ? onTickUp(p, tick) : onTick(p, tick));

export type Quote = { shares: number; cost: number; fee: number; maxLoss: number; payout: number };

/** Buy `amount` USD at limit `price`: shares rounded down to 0.01; fee = taker fee (an upper bound: a resting maker fill pays none). */
export function quote(rawPrice: number, amount: number, feeRate: number, tick: number): Quote | null {
  const price = onTick(rawPrice, tick);
  if (!(price > 0 && price < 1) || !(amount > 0)) return null;
  const shares = Math.floor((amount / price) * SHARE_STEP) / SHARE_STEP;
  if (!(shares > 0)) return null;
  const cost = shares * price, fee = takerFeePerShare(feeRate, price) * shares;
  return { shares, cost, fee, maxLoss: cost + fee, payout: shares };
}

export type FieldErrors = { price?: string; amount?: string; shares?: string };

const priceError = (price: number | null, tick: number, side: "BUY" | "SELL" = "BUY") => {
  const lo = tick, hi = Math.round((1 - tick) * 1e6) / 1e6;
  const r = price == null ? null : roundTick(side, price, tick);
  return r == null || !(r >= lo && r <= hi) ? `Price must be between ${lo} and ${hi}` : undefined;
};

export function validate(price: number | null, amount: number | null, balance: number | null, q: Quote | null, tick: number): FieldErrors {
  const e: FieldErrors = {};
  const pe = priceError(price, tick);
  if (pe) e.price = pe;
  if (amount == null || !(amount > 0)) e.amount = "Enter an amount";
  else if (!q) e.amount = "Amount is too small for one share step";
  else if (balance != null && q.maxLoss > balance) e.amount = "Amount exceeds your balance";
  return e;
}

export type SellQuote = { shares: number; proceeds: number; fee: number };

/** Sell `shares` at limit `price`: shares rounded down to 0.01; price rounds UP to the tick; fee = taker fee (an upper bound); proceeds = shares x price - fee. */
export function sellQuote(rawPrice: number, shares: number, feeRate: number, tick: number): SellQuote | null {
  const price = onTickUp(rawPrice, tick);
  if (!(price > 0 && price < 1) || !(shares > 0)) return null;
  const n = Math.floor(shares * SHARE_STEP + 1e-9) / SHARE_STEP;
  if (!(n > 0)) return null;
  const fee = takerFeePerShare(feeRate, price) * n;
  return { shares: n, proceeds: n * price - fee, fee };
}

/** Sell fields: shares > 0 and <= held of the outcome token, price on the tick range, minOrderSize when the venue states one. */
export function validateSell(o: { price: number | null; shares: number | null; held: number; tick: number; outcome: Side; minShares?: number | null }): FieldErrors {
  const e: FieldErrors = {};
  const pe = priceError(o.price, o.tick, "SELL");
  if (pe) e.price = pe;
  if (!(o.held > 0)) e.shares = `No ${o.outcome} shares to sell`;
  else if (o.shares == null || !(o.shares > 0)) e.shares = "Enter shares to sell";
  else if (o.shares > o.held + 1e-9) e.shares = `You hold ${Math.floor(o.held * SHARE_STEP) / SHARE_STEP} ${o.outcome} shares`;
  else if (Math.floor(o.shares * SHARE_STEP + 1e-9) / SHARE_STEP <= 0) e.shares = "Shares too small for one share step";
  else if (o.minShares != null && Math.floor(o.shares * SHARE_STEP + 1e-9) / SHARE_STEP < o.minShares) e.shares = `Minimum order is ${o.minShares} shares`;
  return e;
}

export type Gate = "disconnected" | "wrong_network" | "creds_needed" | "allowance_checking" | "allowance_needed";
type GateIn = { wallet: "unavailable" | "disconnected" | "connecting" | "connected"; chainOk: boolean; credsReady: boolean; approved: boolean | null };

/** First unmet precondition, in DESIGN 10.4 order; null = ready to trade. */
export function ticketGate(s: GateIn): Gate | null {
  if (s.wallet !== "connected") return "disconnected";
  if (!s.chainOk) return "wrong_network";
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

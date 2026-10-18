"use client";
// Order phase machine of the public ticket: signing -> checking -> open / filled / cancelled / unknown / error.
// The gate (connect, region, creds, allowance) stays in ticketGate; this starts once the gate is clear.
import type { ClobExchange, LimitOrder } from "@pm/pm/exchange";
import { useCallback, useEffect, useRef, useState } from "react";
import { truncate } from "../components/fmt";
import { findPlaced, placeTicketOrder, roundTick } from "../components/public/ticket";
import { isRejection } from "./useWallet";

export const ORDER_TTL_MS = 24 * 3_600_000; // ponytail: GTD 24 h, not in the brief; a resting order should not outlive the visitor's attention by much
export const STATUS_MS = 5_000;

export type OrderPhase =
  | { s: "idle" }
  | { s: "signing" }
  | { s: "checking" }
  | { s: "open"; orderId: string; shares: number; filled: number; avg: number | null; since: number; cancelling?: boolean }
  | { s: "filled"; shares: number; avg: number; fee: number }
  | { s: "cancelled"; shares: number; filled: number }
  | { s: "error"; msg: string }
  | { s: "unknown"; order: LimitOrder; since: number; checking?: boolean };
export type OrderNote = { text: string; tone: "muted" | "neg" };
/** What the ticket submits. `shares` is the already-rounded quote size; `price` is rounded here: BUY down, SELL up. */
export type OrderInput = { side: "BUY" | "SELL"; tokenId: string; price: number; shares: number; tick: number };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const buildOrder = (o: OrderInput, since: number): LimitOrder => ({ tokenId: o.tokenId, side: o.side, price: roundTick(o.side, o.price, o.tick), shares: o.shares, expiresAt: new Date(since + ORDER_TTL_MS) });

/** Fill state of one order: still open (from openOrders), else from its trades. null = too early to tell. */
export async function orderStatus(ex: Pick<ClobExchange, "openOrders" | "trades">, p: Extract<OrderPhase, { s: "open" }>, now = Date.now()): Promise<OrderPhase | null> {
  const [open, trades] = await Promise.all([ex.openOrders(), ex.trades(new Date(p.since - 60_000))]);
  const fills = trades.filter((t) => t.orderId === p.orderId);
  const sh = fills.reduce((a, t) => a + t.shares, 0), cost = fills.reduce((a, t) => a + t.shares * t.price, 0), fee = fills.reduce((a, t) => a + t.fee, 0);
  const o = open.find((x) => x.orderId === p.orderId);
  if (o) return { ...p, filled: o.filled, avg: sh > 0 ? cost / sh : p.avg };
  if (sh >= p.shares - 0.005) return { s: "filled", shares: sh, avg: cost / sh, fee };
  if (!sh && now - p.since < 15_000) return null; // just matched or just placed: openOrders/trades may lag a few seconds
  return { s: "cancelled", shares: p.shares, filled: sh };
}

type Placer = Pick<ClobExchange, "place" | "openOrders" | "trades">;
/** One send. `onChecking` fires when the send did not confirm and the outcome is being looked up (the wait runs only between re-checks). */
export async function sendOrder(ex: Placer, input: OrderInput, since: number, onChecking: () => void, wait?: (ms: number) => Promise<void>, rejection = isRejection): Promise<{ phase: OrderPhase; note?: OrderNote }> {
  const order = buildOrder(input, since);
  const res = await placeTicketOrder(ex, order, rejection, (ms) => { onChecking(); return wait ? wait(ms) : new Promise((r) => setTimeout(r, ms)); });
  switch (res.kind) {
    case "open": return { phase: { s: "open", orderId: res.orderId, shares: input.shares, filled: 0, avg: null, since } };
    case "filled": return { phase: { s: "filled", shares: res.shares, avg: res.avg, fee: res.fee } };
    case "rejected": return { phase: { s: "error", msg: res.error } };
    case "declined": return { phase: { s: "idle" }, note: { text: "You rejected the signature. Nothing was sent.", tone: "muted" } };
    default: return { phase: { s: "unknown", order, since } };
  }
}

/** A new order may start only from idle or after an error (double-submit guard). */
export const canPlace = (p: OrderPhase) => p.s === "idle" || p.s === "error";

/** sendOrder, but null when the exchange changed while it ran (another account or chain): the result belongs to the old one and is dropped. */
export async function sendIfCurrent(ex: Placer, current: () => unknown, input: OrderInput, since: number, onChecking: () => void, wait?: (ms: number) => Promise<void>, rejection = isRejection) {
  const r = await sendOrder(ex, input, since, () => { if (current() === ex) onChecking(); }, wait, rejection);
  return current() === ex ? r : null;
}

/** Re-looks-up an unknown outcome. Still unknown stays `unknown` (not checking). */
export async function recheckOrder(ex: Pick<ClobExchange, "openOrders" | "trades">, p: Extract<OrderPhase, { s: "unknown" }>): Promise<OrderPhase> {
  const res = await findPlaced(ex, p.order, p.since);
  if (res.kind === "open") return { s: "open", orderId: res.orderId, shares: p.order.shares, filled: 0, avg: null, since: p.since };
  if (res.kind === "filled") return { s: "filled", shares: res.shares, avg: res.avg, fee: res.fee };
  return { ...p, checking: false };
}

export type OrderFlow = {
  phase: OrderPhase;
  note: OrderNote | null;
  setNote: (n: OrderNote | null) => void;
  /** Resolves when the outcome phase is set. No-op without an exchange. */
  place: (o: OrderInput) => Promise<void>;
  recheck: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Back to idle (New order / Try again / Start over). */
  reset: () => void;
};

/** `refresh` re-reads balance, orders and positions after a send or cancel. A new `exchange` (account or chain) drops the order view. */
export function useOrderFlow(exchange: ClobExchange | null, refresh: () => Promise<void>): OrderFlow {
  const [phase, setPhase] = useState<OrderPhase>({ s: "idle" });
  const [note, setNote] = useState<OrderNote | null>(null);
  useEffect(() => setPhase({ s: "idle" }), [exchange]);

  const openId = phase.s === "open" ? phase.orderId : null;
  const cur = useRef(phase);
  cur.current = phase;
  const exRef = useRef(exchange);
  exRef.current = exchange;
  useEffect(() => {
    const ex = exchange;
    if (!openId || !ex) return;
    const live = (p: OrderPhase) => p.s === "open" && p.orderId === openId && !p.cancelling;
    let inflight = false; // a slow CLOB must not stack status calls every 5 s
    const tick = () => {
      const p = cur.current;
      if (inflight || p.s !== "open" || !live(p)) return;
      inflight = true;
      // CLOB down: keep polling; AccountPanel shows the error.
      orderStatus(ex, p).then((n) => n && setPhase((x) => (live(x) ? n : x))).catch(() => {}).finally(() => { inflight = false; });
    };
    tick();
    const t = setInterval(tick, STATUS_MS);
    return () => clearInterval(t);
  }, [openId, exchange]);

  const place = useCallback(async (o: OrderInput) => {
    if (!exchange || !canPlace(cur.current)) return;
    cur.current = { s: "signing" }; // closes the window before the next render
    setNote(null);
    setPhase({ s: "signing" });
    const r = await sendIfCurrent(exchange, () => exRef.current, o, Date.now(), () => setPhase({ s: "checking" }));
    if (!r) return;
    setPhase(r.phase);
    if (r.note) setNote(r.note);
    void refresh();
  }, [exchange, refresh]);

  const recheck = useCallback(async () => {
    const p = cur.current;
    if (p.s !== "unknown" || !exchange) return;
    setPhase({ ...p, checking: true });
    setPhase(await recheckOrder(exchange, p));
  }, [exchange]);

  const cancel = useCallback(async () => {
    const p = cur.current;
    if (p.s !== "open" || !exchange) return;
    setPhase({ ...p, cancelling: true });
    try {
      await exchange.cancel([p.orderId]);
      const n = await orderStatus(exchange, { ...p, since: 0 }); // since 0: never wait on lag after an explicit cancel
      setPhase(n ?? { s: "cancelled", shares: p.shares, filled: p.filled });
      void refresh();
    } catch (e) {
      setPhase({ ...p, cancelling: false });
      setNote({ text: `Cancel failed: ${truncate(msg(e), 80)}`, tone: "neg" });
    }
  }, [exchange, refresh]);

  return { phase, note, setNote, place, recheck, cancel, reset: useCallback(() => setPhase({ s: "idle" }), []) };
}

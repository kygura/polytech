"use client";
// TradeTicket (DESIGN 10.4). Orders are signed by the visitor's wallet and sent browser -> clob.polymarket.com (no server relay).
import type { ClobExchange, LimitOrder } from "@pm/pm/exchange";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRegion } from "../../hooks/useRegion";
import { isRejection, useWallet } from "../../hooks/useWallet";
import type { PublicMarketDetail } from "../../lib/public";
import { loadVisitorSettings } from "../../lib/visitor/settings";
import { fmt, truncate } from "../fmt";
import ui from "../ui.module.css";
import { short } from "./PublicShell";
import { bestAsk, findPlaced, onTick, placeTicketOrder, prefill, quote, ticketGate, TICK, validate, type Gate } from "./ticket";
import css from "./public.module.css";

const ORDER_TTL_MS = 24 * 3_600_000; // ponytail: GTD 24 h, not in the brief; a resting order should not outlive the visitor's attention by much
const STATUS_MS = 5_000;
const usd = (v: number) => `$${v.toFixed(2)}`;
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const shares = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Side = "YES" | "NO";
type Phase =
  | { s: "idle" }
  | { s: "signing" }
  | { s: "checking" }
  | { s: "open"; orderId: string; shares: number; filled: number; avg: number | null; since: number; cancelling?: boolean }
  | { s: "filled"; shares: number; avg: number; fee: number }
  | { s: "cancelled"; shares: number; filled: number }
  | { s: "error"; msg: string }
  | { s: "unknown"; order: LimitOrder; since: number; checking?: boolean };

const GATE: Record<Gate, { button: string; copy: string; spin?: boolean; off?: boolean }> = {
  disconnected: { button: "Connect wallet", copy: "Connect a wallet on Polygon to trade. Research above stays free to read." },
  wrong_network: { button: "Switch to Polygon", copy: "Your wallet is on another network. Polymarket runs on Polygon." },
  geo_checking: { button: "Checking region…", copy: "Checking whether Polymarket accepts orders from your location.", spin: true, off: true },
  geo_blocked: { button: "Trading unavailable", copy: "Polymarket does not accept orders from your region. Research stays available. We do not offer a way around this.", off: true },
  geo_failed: { button: "Trading unavailable", copy: "Could not confirm your region, so trading stays off. Retry, or try again later.", off: true },
  creds_needed: { button: "Enable trading (1 signature)", copy: "Polymarket needs a one-time signature to create your API key for this session. It is not a transaction and costs nothing." },
  allowance_checking: { button: "Checking allowance…", copy: "Checking whether Polymarket's exchange can spend your USDC.", spin: true, off: true },
  allowance_needed: { button: "Approve USDC (1 transaction)", copy: "Polymarket's exchange needs permission to spend your USDC. This is an on-chain transaction and costs a little POL for gas. One time per wallet." },
};

/** Fill state of one order: still open (from openOrders), else from its trades. */
async function orderStatus(ex: ClobExchange, p: Extract<Phase, { s: "open" }>): Promise<Phase | null> {
  const [open, trades] = await Promise.all([ex.openOrders(), ex.trades(new Date(p.since - 60_000))]);
  const fills = trades.filter((t) => t.orderId === p.orderId);
  const sh = fills.reduce((a, t) => a + t.shares, 0), cost = fills.reduce((a, t) => a + t.shares * t.price, 0), fee = fills.reduce((a, t) => a + t.fee, 0);
  const o = open.find((x) => x.orderId === p.orderId);
  if (o) return { ...p, filled: o.filled, avg: sh > 0 ? cost / sh : p.avg };
  if (sh >= p.shares - 0.005) return { s: "filled", shares: sh, avg: cost / sh, fee };
  if (!sh && Date.now() - p.since < 15_000) return null; // just matched or just placed: openOrders/trades may lag a few seconds
  return { s: "cancelled", shares: p.shares, filled: sh };
}

export function TradeTicket({ d }: { d: PublicMarketDetail }) {
  const w = useWallet(), r = useRegion(), c = w.clob;
  const btn = useRef<HTMLButtonElement>(null);
  const [side, setSide] = useState<Side>("YES");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [note, setNote] = useState<{ text: string; tone: "muted" | "neg" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [perTradeMax] = useState(() => loadVisitorSettings().limits.perTradeUsd);

  // The ticket counts as opened: run the region check now so the state is known before the visitor connects.
  const { ensure } = r;
  useEffect(() => ensure(), [ensure]);

  // Prefill until the visitor edits a field: thesis side, livelimitPrice limit, sizeTrade amount once the balance is known.
  const id = d.market.conditionId, balance = c.balance;
  useEffect(() => {
    if (touched) return;
    const p = prefill(d, balance);
    setSide(p.side);
    setPrice(p.price == null ? "" : p.price.toFixed(3));
    setAmount(p.amount == null ? "" : p.amount.toFixed(2));
    // Deps on purpose: re-prefill on market or balance change, not on every 60 s poll of `d`.
  }, [id, balance, touched]);

  // A new account or chain means new credentials: drop the order view with them.
  useEffect(() => setPhase({ s: "idle" }), [w.exchange]);

  const openId = phase.s === "open" ? phase.orderId : null;
  const cur = useRef(phase);
  cur.current = phase;
  useEffect(() => {
    const ex = w.exchange;
    if (!openId || !ex) return;
    const live = (p: Phase) => p.s === "open" && p.orderId === openId && !p.cancelling;
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
  }, [openId, w.exchange]);

  const gate = ticketGate({ wallet: w.status, chainOk: w.chainOk, region: r.status, credsReady: c.credsReady, approved: c.approved });
  const pr = num(price), amt = num(amount);
  const q = pr == null || amt == null ? null : quote(pr, amt, d.market.feeRate);
  const errs = validate(pr, amt, balance, q);
  if (!errs.amount && q && q.maxLoss > perTradeMax) errs.amount = `Above your per-trade max $${perTradeMax}`;
  const valid = !errs.price && !errs.amount && q != null;
  const mid = d.snapshot?.mid == null ? null : side === "YES" ? d.snapshot.mid : 1 - d.snapshot.mid;
  const ask = bestAsk(d, side);
  const tokenId = side === "YES" ? d.market.yesTokenId : d.market.noTokenId;
  const fields = gate === null && phase.s === "idle"; // ready
  const editable = phase.s === "idle" || phase.s === "error";

  const edit = (f: () => void) => { setTouched(true); setNote(null); f(); };
  const pickSide = (s: Side) => edit(() => {
    setSide(s);
    const p = prefill(d, balance);
    const lim = s === p.side ? p.price : bestAsk(d, s);
    setPrice(lim == null ? "" : lim.toFixed(3));
  });
  const sideKeys = (e: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const s: Side = side === "YES" ? "NO" : "YES";
    pickSide(s);
    (e.currentTarget.querySelector(`[data-side="${s}"]`) as HTMLButtonElement | null)?.focus();
  };

  const run = async (f: () => Promise<void>, rejected: string) => {
    setBusy(true);
    setNote(null);
    try { await f(); }
    catch (e) { setNote(isRejection(e) ? { text: rejected, tone: "muted" } : { text: truncate(msg(e), 120), tone: "neg" }); }
    finally { setBusy(false); btn.current?.focus(); }
  };

  const place = async () => {
    const ex = w.exchange;
    if (!ex || !q || !valid || !tokenId || pr == null) return;
    setNote(null);
    setPhase({ s: "signing" });
    const since = Date.now();
    const order: LimitOrder = { tokenId, side: "BUY", price: onTick(pr), shares: q.shares, expiresAt: new Date(since + ORDER_TTL_MS) };
    // the send didn't confirm: say so while the outcome is looked up (the wait runs only between re-checks)
    const res = await placeTicketOrder(ex, order, isRejection, (ms) => { setPhase({ s: "checking" }); return new Promise((r) => setTimeout(r, ms)); });
    if (res.kind === "open") setPhase({ s: "open", orderId: res.orderId, shares: q.shares, filled: 0, avg: null, since });
    else if (res.kind === "filled") setPhase({ s: "filled", shares: res.shares, avg: res.avg, fee: res.fee });
    else if (res.kind === "rejected") setPhase({ s: "error", msg: res.error });
    else if (res.kind === "declined") { setPhase({ s: "idle" }); setNote({ text: "You rejected the signature. Nothing was sent.", tone: "muted" }); }
    else setPhase({ s: "unknown", order, since });
    void c.refresh();
    btn.current?.focus();
  };

  const recheck = async () => {
    const ex = w.exchange;
    if (phase.s !== "unknown" || !ex) return;
    const p = phase;
    setPhase({ ...p, checking: true });
    const res = await findPlaced(ex, p.order, p.since);
    if (res.kind === "open") setPhase({ s: "open", orderId: res.orderId, shares: p.order.shares, filled: 0, avg: null, since: p.since });
    else if (res.kind === "filled") setPhase({ s: "filled", shares: res.shares, avg: res.avg, fee: res.fee });
    else setPhase({ ...p, checking: false });
  };
  // Leaving "unknown" clears the amount: no one-click identical resend.
  const startOver = () => { setPhase({ s: "idle" }); setTouched(true); setAmount(""); };

  const cancel = async () => {
    const ex = w.exchange;
    if (phase.s !== "open" || !ex) return;
    const p = phase;
    setPhase({ ...p, cancelling: true });
    try {
      await ex.cancel([p.orderId]);
      const n = await orderStatus(ex, { ...p, since: 0 }); // since 0: never wait on lag after an explicit cancel
      setPhase(n ?? { s: "cancelled", shares: p.shares, filled: p.filled });
      void c.refresh();
    } catch (e) {
      setPhase({ ...p, cancelling: false });
      setNote({ text: `Cancel failed: ${truncate(msg(e), 80)}`, tone: "neg" });
    }
  };

  // Button + state line, by state. The same <button> element in every state keeps focus on it (DESIGN 10.7).
  let label: string, onClick: (() => void) | undefined, spin = false, off = false, stateWord: string, line: React.ReactNode = null, aria: string | undefined;
  if (gate) {
    const g = GATE[gate];
    label = gate === "disconnected" && w.status === "unavailable" ? "No wallet found" : gate === "disconnected" && w.status === "connecting" ? "Connecting…" : g.button;
    spin = !!g.spin || w.status === "connecting";
    off = !!g.off || w.status === "unavailable" || w.status === "connecting";
    stateWord = gate.replace(/_/g, " ");
    line = gate === "geo_failed"
      ? <>{g.copy} <button type="button" className={css.linkBtn} onClick={r.retry}>Retry check</button></>
      : gate === "geo_blocked" ? <span role="alert">{g.copy}</span> : g.copy;
    if (gate === "disconnected") onClick = () => void w.connect();
    if (gate === "wrong_network") onClick = () => void w.switchChain();
    if (gate === "creds_needed") { onClick = () => void run(c.enable, "You rejected the signature. Trading stays off."); if (c.enabling || busy) { label = "Confirm in your wallet…"; spin = off = true; } }
    if (gate === "allowance_checking" && c.error) line = <>{c.error} <button type="button" className={css.linkBtn} onClick={() => void c.checkApproval().catch(() => {})}>Retry check</button></>;
    if (gate === "allowance_needed") { onClick = () => void run(c.approve, "You rejected the transaction. Nothing was approved."); if (c.approving || busy) { label = "Confirm in your wallet…"; spin = off = true; } }
  } else {
    switch (phase.s) {
      case "idle":
        label = "Sign and place order"; stateWord = "ready"; off = !valid; onClick = () => void place();
        if (q) aria = `Sign and place order: buy ${side} ${shares(q.shares)} shares at ${onTick(pr!).toFixed(3)}, up to ${usd(q.maxLoss)}`;
        break;
      case "checking":
        label = "Checking if your order went through…"; spin = off = true; stateWord = "checking";
        line = "The send didn't confirm. Looking it up on Polymarket before anything else.";
        break;
      case "signing":
        label = "Confirm in your wallet…"; spin = off = true; stateWord = "signing";
        line = "Check your wallet window. Rejecting there cancels nothing; no order was sent.";
        break;
      case "open":
        label = phase.cancelling ? "cancelling…" : phase.filled > 0 ? "Cancel rest" : "Cancel order"; off = !!phase.cancelling; onClick = () => void cancel();
        stateWord = phase.filled > 0 ? "partial" : "submitted";
        line = phase.filled > 0
          ? `Partially filled · ${shares(phase.filled)}/${shares(phase.shares)}${phase.avg != null ? ` at ${phase.avg.toFixed(3)}` : ""}`
          : `Order open · ord ${short(phase.orderId)} · ${shares(phase.filled)}/${shares(phase.shares)} filled`;
        break;
      case "filled":
        label = "New order"; stateWord = "filled"; onClick = () => setPhase({ s: "idle" });
        line = <span className="pos">Filled {"·"} {shares(phase.shares)} shares at {phase.avg.toFixed(3)} {"·"} fee {usd(phase.fee)}</span>;
        break;
      case "cancelled":
        label = "New order"; stateWord = "cancelled"; onClick = () => setPhase({ s: "idle" });
        line = <span className="muted">cancelled {"·"} {shares(phase.filled)}/{shares(phase.shares)} filled</span>;
        break;
      case "unknown":
        label = phase.checking ? "Checking open orders…" : "Check open orders"; spin = off = !!phase.checking; stateWord = "unknown"; onClick = () => void recheck();
        line = <span className="neg">Outcome unknown {"—"} check open orders before retrying. <button type="button" className={css.linkBtn} onClick={startOver}>Start over</button></span>;
        break;
      case "error":
        label = "Try again"; stateWord = "error"; onClick = () => setPhase({ s: "idle" });
        line = <span className="neg" title={phase.msg}>Order failed: {truncate(phase.msg, 80)}</span>;
        break;
    }
  }

  const border = gate === "geo_blocked" ? css.ticketNeg : gate === "geo_failed" ? css.ticketWarn : "";
  return (
    <section className={`pane ${border}`} aria-label="trade ticket">
      <h2>Trade {"·"} your wallet <span className="muted">{"·"} {stateWord}</span></h2>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); if (fields && valid) void place(); }}>
        <span className={css.lbl} id="tk-side">Side</span>
        <div className={css.seg} role="radiogroup" aria-labelledby="tk-side" onKeyDown={sideKeys}>
          {(["YES", "NO"] as const).map((s) => (
            <button key={s} type="button" role="radio" data-side={s} aria-checked={side === s} tabIndex={side === s ? 0 : -1} disabled={!editable} onClick={() => pickSide(s)}>BUY {s}</button>
          ))}
        </div>

        <label htmlFor="tk-price">Limit price</label>
        <input id="tk-price" type="number" inputMode="decimal" step={TICK} min={TICK} max={1 - TICK} value={price} disabled={!editable}
          aria-invalid={fields && !!errs.price} aria-describedby="tk-price-hint" onChange={(e) => edit(() => setPrice(e.target.value))} />
        <span className={css.hint} id="tk-price-hint">mid {fmt(mid, "p")} {"·"} best ask {fmt(ask, "p")}{pr != null && onTick(pr) !== pr && ` · sends ${onTick(pr).toFixed(3)} (tick ${TICK})`}</span>
        {fields && errs.price && price !== "" && <span className={css.fieldErr}>{errs.price}</span>}

        <label htmlFor="tk-amount">Amount <span className="muted">USD</span></label>
        <input id="tk-amount" type="number" inputMode="decimal" step="0.01" min="0" value={amount} disabled={!editable}
          aria-invalid={fields && !!errs.amount && amount !== ""} aria-describedby="tk-amount-hint" onChange={(e) => edit(() => setAmount(e.target.value))} />
        <span className={css.hint} id="tk-amount-hint">{balance != null ? `Balance ${usd(balance)}` : "Balance —"}</span>
        {fields && errs.amount && amount !== "" && <span className={css.fieldErr}>{errs.amount}</span>}

        <span className={css.lbl}>Est. shares</span><span>{q ? shares(q.shares) : "—"}</span>
        <span className={css.lbl}>Fee</span><span title="taker fee, an upper bound: a resting order that fills as maker pays none">{q ? usd(q.fee) : "—"}</span>
        <span className={css.lbl}>Max loss</span><span>{q ? usd(q.maxLoss) : "—"}</span>
        <span className={css.lbl}>Payout if right</span><span>{q ? usd(q.payout) : "—"}</span>
        {/* Enter in a field submits only in ready (the form's onSubmit checks). */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
      <div className={css.foot}>
        <p className="muted">Your wallet will ask you to sign this order. Signing sends it to Polymarket; it does not move funds until the order fills.</p>
        <button ref={btn} type="button" className={`${css.primary} ${gate === null && phase.s === "idle" ? css.live : gate === "disconnected" ? css.connect : ""}`}
          disabled={off} aria-label={aria} onClick={onClick}>
          {spin && <span className={ui.spinner} aria-hidden />}{label}
        </button>
        <p aria-live="polite">{line}</p>
        {note && <p className={note.tone}>{note.text}</p>}
      </div>
    </section>
  );
}

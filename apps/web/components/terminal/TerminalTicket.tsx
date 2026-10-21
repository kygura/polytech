"use client";
// TerminalTicket (DESIGN 11.6). Paper (default): POST /api/paper/order, fills against the live book, no wallet. Live: signed by the visitor's
// wallet, sent browser -> clob.polymarket.com; gate and phase machine as TradeTicket. The mode lives in the header (useTradingMode).
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Clob } from "../../hooks/useClob";
import { inInput } from "../../hooks/useGlobalKeys";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import { useOrderFlow, type OrderPhase } from "../../hooks/useOrderFlow";
import { useTradingMode } from "../../hooks/useTradingMode";
import { isRejection, type Wallet } from "../../hooks/useWallet";
import type { PublicMarketDetail } from "../../lib/public";
import { loadVisitorSettings } from "../../lib/visitor/settings";
import { truncate } from "../fmt";
import {
  buyEstimate, DEFAULT_TICK, fillText, quote, roundTick, sellEstimate, sellQuote, ticketGate, validate, validatePaper, validateSell,
  type FieldErrors, type PaperFill,
} from "./ticket";
import { cents, errMsg, forOutcome, nudge, sh, usd, type Outcome, type TradeSide } from "./book";
import { plain } from "./research";
import { buttonState, type Action } from "./rules";
import css from "./terminal.module.css";

const NUM = /^\d*\.?\d*$/; // typing filter: digits and one dot
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}`;
const LIVE_BUSY: OrderPhase["s"][] = ["signing", "checking", "unknown"]; // a live send still being settled: the ticket stays live until it resolves

export type TicketHandle = {
  /** Focus the first field (the amount). */
  focus: () => void;
  /** "Buy YES" from Our view: the amount for `side` (applied after the side change lands). */
  prefill: (o: { side: TradeSide; usd: number }) => void;
};
type Props = {
  /** The selected market (route id): a change resets the fields and the order view. */
  marketId: string | null;
  detail: PublicMarketDetail | null; feed: MarketFeed | null; noBook: boolean;
  side: TradeSide; outcome: Outcome; onSide: (s: TradeSide) => void; onOutcome: (o: Outcome) => void;
  /** Live: sellable shares of the chosen outcome's token (held minus own resting SELLs), the SELL cap. */
  held: number;
  /** Paper: open paper shares of the chosen outcome's token and their average cost. */
  paper: { shares: number; avgCost: number | null };
  /** A ladder click: copy `price` (0–1, the outcome's book) to Limit. `n` changes on every pick. */
  pick: { price: number; n: number } | null;
  wallet: Wallet & { clob: Clob };
  /** The order phase and whether side/outcome are locked, for the page's market-switch guard and B/S/Y/N keys. */
  onState: (s: { phase: OrderPhase["s"]; locked: boolean }) => void;
  /** A paper order filled: refetch positions. */
  onFilled: () => void;
};

export const TerminalTicket = forwardRef<TicketHandle, Props>(function TerminalTicket({ marketId, detail, feed, noBook, side, outcome, onSide, onOutcome, held, paper, pick, wallet: w, onState, onFilled }, handle) {
  const c = w.clob;
  const { mode, setMode } = useTradingMode();
  const btn = useRef<HTMLButtonElement>(null), limitEl = useRef<HTMLInputElement>(null), amountEl = useRef<HTMLInputElement>(null);
  const [price, setPrice] = useState(""); // cents
  const [amount, setAmount] = useState(""); // BUY: dollars; SELL: shares
  const [limitOn, setLimitOn] = useState(false); // paper: market order unless a limit is set
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: "up" | "warn" | "neg"; raw?: string } | null>(null);
  const flow = useOrderFlow(w.exchange, c.refresh);
  const { phase, note, setNote } = flow;
  const [perTradeMax] = useState(() => loadVisitorSettings().limits.perTradeUsd);
  const lastField = useRef<HTMLInputElement | null>(null); // Esc on the armed button returns here
  const sideNow = useRef(side), pending = useRef<string | null>(null), pseq = useRef(0);
  sideNow.current = side;
  useImperativeHandle(handle, () => ({
    focus: () => amountEl.current?.focus(),
    prefill: ({ side: s, usd: v }) => {
      const t = String(Math.max(1, Math.round(v)));
      if (s === sideNow.current) setAmount(t); else pending.current = t;
      setResult(null);
      requestAnimationFrame(() => amountEl.current?.focus());
    },
  }), []);

  const live = mode === "live" || LIVE_BUSY.includes(phase.s);
  const id = marketId;
  const tick = feed?.tickSize ?? null;
  const book = feed ? forOutcome(feed, outcome) : null;

  // Market switch: fresh fields and order view.
  const prefilled = useRef<string | null>(null), lastTick = useRef<number | null>(null);
  const { reset } = flow;
  useEffect(() => { setPrice(""); setAmount(""); setHint(null); setLimitOn(false); setResult(null); pseq.current++; setBusy(false); prefilled.current = null; lastTick.current = null; reset(); }, [id, reset]);
  // Side switch: the amount changes unit ($ <-> shares).
  useEffect(() => { setAmount(pending.current ?? ""); pending.current = null; }, [side]);
  useEffect(() => { setResult(null); setArmed(false); }, [mode]);

  // Prefill once per market + side + outcome, from the live book: best ask for Buy, best bid for Sell. Feed polls never overwrite fields.
  useEffect(() => {
    if (!book || tick == null || !id || detail?.market.conditionId !== id || book.tokenId !== detail.market.yesTokenId) return;
    const k = `${id}|${side}|${outcome}`;
    if (prefilled.current === k) return;
    prefilled.current = k;
    const p = side === "BUY" ? book.asks[0]?.price : book.bids[0]?.price;
    setPrice(p == null ? "" : cents(p, tick));
  });

  // Tick changed under a typed price: re-round and say so.
  useEffect(() => {
    if (tick == null) return;
    const was = lastTick.current;
    lastTick.current = tick;
    const v = num(price);
    if (was == null || was === tick || v == null) return;
    setPrice(cents(roundTick(side, v / 100, tick), tick));
    setHint(`Rounded to the price step ${cents(tick, tick)}¢`);
  }, [tick]); // only a tick change re-rounds

  useEffect(() => {
    if (!pick || tick == null) return;
    setPrice(cents(pick.price, tick));
    setLimitOn(true);
    setHint(null);
    amountEl.current?.focus();
  }, [pick]); // every pick, never on a tick change

  const gate = ticketGate({ wallet: w.status, chainOk: w.chainOk, credsReady: c.credsReady, approved: c.approved });
  const loaded = feed != null && tick != null && detail != null && detail.market.conditionId === id && feed.tokenId === detail.market.yesTokenId;
  const p01 = num(price) == null ? null : num(price)! / 100, n = num(amount);
  const tokenId = detail ? (outcome === "YES" ? detail.market.yesTokenId : detail.market.noTokenId) : null;
  const feeRate = detail?.market.feeRate ?? 0, feeExp = detail?.market.feeExponent ?? 1, minSh = feed?.minOrderSize ?? null;
  const t = tick ?? DEFAULT_TICK, cc = (p: number) => cents(p, t);
  const cap = live ? held : paper.shares;
  const verb = side === "BUY" ? "Buy" : "Sell";

  // ---- live: limit order, signed in the wallet
  let errs: FieldErrors = {}, nShares: number | null = null, sendPrice: number | null = null;
  let summary: [string, string, string?][] = [], aria: string | undefined;
  // ---- paper: market order (or limit), estimate from the book
  let est: ReactNode = null, paperValid = false;
  if (live && loaded) {
    sendPrice = p01 == null ? null : roundTick(side, p01, tick);
    if (side === "BUY") {
      const q = p01 == null || n == null ? null : quote(p01, n, feeRate, tick, feeExp);
      errs = validate(p01, n, c.balance, q, tick);
      if (!errs.amount && q && minSh != null && q.shares < minSh) errs.amount = `Minimum order is ${sh(minSh)} shares`;
      if (!errs.amount && q && q.maxLoss > perTradeMax) errs.amount = `Above your per-trade max $${perTradeMax} (Settings)`;
      nShares = q?.shares ?? null;
      summary = [["Shares", q ? sh(q.shares) : "—"], ["Cost with fee, at most", q ? usd(q.maxLoss) : "—", css.down], [`Pays if ${outcome} wins`, q ? usd(q.payout) : "—", css.up]];
      if (q) aria = `buy ${outcome} ${sh(q.shares)} shares at ${cents(sendPrice, tick)} cents, up to ${usd(q.maxLoss)}`;
    } else {
      const q = p01 == null || n == null ? null : sellQuote(p01, n, feeRate, tick, feeExp);
      errs = validateSell({ price: p01, shares: n, held, tick, outcome, minShares: minSh });
      nShares = q?.shares ?? null;
      const show = q && !errs.shares; // over the cap: no proceeds for shares that can't be sold
      summary = [["You get, at least", show ? usd(q.proceeds) : "—", css.up], ["Fee, at most", show ? usd(q.fee) : "—"]];
      if (q) aria = `sell ${outcome} ${sh(q.shares)} shares at ${cents(sendPrice, tick)} cents, proceeds about ${usd(q.proceeds)}`;
    }
  } else if (!live) {
    const lim = limitOn && p01 != null ? roundTick(side, p01, t) : null;
    errs = validatePaper({ side, usd: n, shares: n, held: paper.shares, limit: p01, limitOn, tick: t, outcome });
    paperValid = detail != null && detail.market.conditionId === id && !!id && !noBook && !errs.price && !errs.amount && !errs.shares;
    if (paperValid && book) {
      if (side === "BUY") {
        const e = buyEstimate(book.asks, n!, feeRate, feeExp, lim);
        est = e ? <>
          <div>{"≈"} <b className={css.n}>{sh(e.shares)}</b> shares at avg <b className={css.n}>{cc(e.avg)}¢</b>{e.fee > 0.005 && <> {"·"} fee <span className={css.n}>{usd(e.fee)}</span></>}</div>
          <div>Pays <b className={`${css.n} ${css.up}`}>{usd(e.payout)}</b> if {outcome} wins {"·"} profit <b className={`${css.n} ${e.profit >= 0 ? css.up : css.down}`}>{signed(e.profit)}</b></div>
          {!e.complete && <div className={css.warn}>Only {usd(e.spent)} of {usd(n!)} fills on the book now{lim != null ? " at your limit" : ""}</div>}
        </> : <div className={css.warn}>Nothing fills now: {lim != null ? "no sellers at or under your limit" : "no sellers on the book"}</div>;
      } else {
        const e = sellEstimate(book.bids, n!, feeRate, feeExp, lim, paper.avgCost);
        est = e ? <>
          <div>{"≈"} <b className={css.n}>{sh(e.shares)}</b> shares at avg <b className={css.n}>{cc(e.avg)}¢</b> {"·"} you get <b className={`${css.n} ${css.up}`}>{usd(e.proceeds)}</b></div>
          {e.pnl != null && <div>Profit on these shares <b className={`${css.n} ${e.pnl >= 0 ? css.up : css.down}`}>{signed(e.pnl)}</b> (vs. what you paid)</div>}
          {!e.complete && <div className={css.warn}>Only {sh(e.shares)} of {sh(n!)} shares find a buyer now{lim != null ? " at your limit" : ""}</div>}
        </> : <div className={css.warn}>Nothing fills now: {lim != null ? "no buyers at or over your limit" : "no buyers on the book"}</div>;
      }
    } else if (paperValid) est = <div>The estimate appears when the live book loads.</div>;
  }
  const amountErr = side === "BUY" ? errs.amount : errs.shares;
  const valid = loaded && !errs.price && !amountErr && nShares != null && sendPrice != null && !!tokenId;
  const canSend = live ? gate === null && phase.s === "idle" && valid : paperValid && !busy;
  const editable = live ? phase.s === "idle" || phase.s === "error" : !busy;
  useEffect(() => onState({ phase: phase.s, locked: !editable }), [phase.s, editable, onState]);
  const orderText = valid ? `${verb} ${sh(nShares!)} ${outcome} at ${cents(sendPrice, tick!)}¢` : "";
  const offTick = live && loaded && p01 != null && Math.abs(roundTick(side, p01, tick) - p01) > 1e-9
    ? `Not on the ${cents(tick, tick)}¢ price step — rounds ${side === "BUY" ? "down" : "up"} to ${cents(roundTick(side, p01, tick), tick)}¢` : null;

  const edit = (f: () => void) => { setNote(null); setHint(null); setResult(null); f(); };
  // Focus after the re-render: the button is still disabled when the send or wallet prompt resolves (DESIGN 10.7).
  const [focusReq, setFocusReq] = useState(0);
  const refocus = () => setFocusReq((x) => x + 1);
  useEffect(() => {
    if (!focusReq || phase.s === "signing" || phase.s === "checking") return;
    const b = btn.current;
    (b && !b.disabled ? b : lastField.current ?? amountEl.current)?.focus();
  }, [focusReq, phase.s]);

  const placePaper = async () => {
    if (!canSend || !id) return;
    setArmed(false);
    const seq = ++pseq.current;
    setBusy(true);
    setResult(null);
    const body = { conditionId: id, outcome, side, ...(side === "BUY" ? { usd: n! } : { shares: n! }), ...(limitOn && p01 != null ? { limit: roundTick(side, p01, t) } : {}) };
    try {
      const r = await fetch("/api/paper/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => null)) as (PaperFill & { error?: string }) | null;
      if (seq !== pseq.current) return; // market switched meanwhile
      if (r.ok && j?.ok) { setResult({ text: fillText(j, cc), tone: j.partial ? "warn" : "up" }); setAmount(""); onFilled(); }
      else setResult({ text: `Not filled: ${plain(j?.error ?? `server answered ${r.status}`)}`, tone: "neg", raw: j?.error });
    } catch (e) {
      if (seq === pseq.current) setResult({ text: "Not filled: could not reach the server", tone: "neg", raw: errMsg(e) });
    } finally {
      if (seq === pseq.current) { setBusy(false); refocus(); }
    }
  };
  const placeLive = async () => {
    if (!canSend) return;
    setArmed(false);
    await flow.place({ side, tokenId: tokenId!, price: p01!, shares: nShares!, tick: tick! });
    refocus();
  };
  const place = () => void (live ? placeLive() : placePaper());
  const run = async (f: () => Promise<void>, rejected: string) => {
    setBusy(true);
    setNote(null);
    try { await f(); }
    catch (e) { setNote(isRejection(e) ? { text: rejected, tone: "muted" } : { text: truncate(errMsg(e), 120), tone: "neg" }); }
    finally { setBusy(false); refocus(); }
  };
  // Leaving "unknown" clears the amount: no one-click identical resend.
  const startOver = () => { flow.reset(); setAmount(""); };
  const newOrder = () => { flow.reset(); setAmount(""); prefilled.current = null; };

  // ⏎ arms (focuses the submit in review), ⌘⏎ / Ctrl⏎ places; ↑↓ nudge (DESIGN 11.5).
  const fieldKeys = (which: "limit" | "amount") => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      lastField.current = e.currentTarget;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) place();
      else { setArmed(canSend); btn.current?.focus(); }
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" ? 1 : -1, k = e.shiftKey ? 10 : 1;
    if (which === "limit") {
      if (tick == null) return;
      const base = p01 ?? book?.mid ?? 0.5;
      edit(() => setPrice(cents(nudge(side, base, dir * k, tick), tick)));
    } else {
      const step = side === "BUY" ? 1 : minSh ?? 1;
      edit(() => setAmount(String(Math.max(0, Math.round(((n ?? 0) + dir * k * step) * 100) / 100))));
    }
  };

  // X cancels the ticket's order when no open-orders row has focus (that row handles its own X).
  useEffect(() => {
    if (phase.s !== "open" || !live) return; // a resting live order is not cancelled from the paper ticket
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== "x" && e.key !== "X") || e.metaKey || e.ctrlKey || e.altKey || inInput(e)) return;
      if ((document.activeElement as HTMLElement | null)?.closest("[data-order-row]")) return;
      void flow.cancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [phase.s, flow, live]);

  const bs = buttonState({
    loaded, noBook, gate, wallet: w.status, signing: c.enabling || c.approving || busy, allowanceError: c.error,
    phase, valid, armed: armed && canSend, outcome, orderText, c: (p) => cents(p, tick ?? DEFAULT_TICK),
  });
  const act: Record<Action, () => void> = {
    connect: () => void w.connect(), switchChain: () => void w.switchChain(),
    enable: () => void run(c.enable, "You rejected the signature. Trading stays off."),
    approve: () => void run(c.approve, "You rejected the transaction. Nothing was approved."),
    place, cancel: () => void flow.cancel(), newOrder, recheck: () => void flow.recheck(), reset: flow.reset,
  };
  const links = { retryAllowance: ["Retry check", () => void c.checkApproval().catch(() => {})], startOver: ["Start over", startOver] } as const;

  // The submit button and its line, by mode.
  let goLabel: ReactNode, goLook: string | undefined, goOff: boolean, goAct: (() => void) | undefined, goAria: string | undefined, line: ReactNode = null;
  if (live) {
    goLabel = <>{bs.spin && <span className={css.spin} aria-hidden />}{bs.action === "place" ? <><span className={css.liveTag}>LIVE</span>{bs.label}</> : bs.label}{bs.kbd.map((k) => <kbd key={k}>{k}</kbd>)}</>;
    goLook = { off: css.off, act: css.act, connect: css.connect, yes: css.yes, no: css.no }[bs.look];
    goOff = bs.off;
    goAct = bs.action ? act[bs.action] : undefined;
    goAria = bs.action === "place" && aria ? `Real money. Sign and place order: ${aria}` : undefined;
    if (bs.line) {
      const l = bs.line, link = l.link ? links[l.link] : null;
      const body = <>{l.text}{link && <> <button type="button" className={css.link} onClick={link[1]}>{link[0]}</button></>}</>;
      line = <span className={l.tone === "neg" ? css.down : l.tone === "up" ? css.up : undefined} title={phase.s === "error" ? phase.msg : undefined}>{body}</span>;
    }
  } else {
    const ready = canSend;
    goLabel = <>{busy && <span className={css.spin} aria-hidden />}{busy ? "Filling…" : `${verb} ${outcome} · paper`}{ready && <kbd>⏎</kbd>}</>;
    goLook = ready ? (outcome === "YES" ? css.yes : css.no) : css.off;
    goOff = !ready;
    goAct = place;
    line = noBook ? "No live order book for this market, so nothing can fill."
      : armed && ready ? "⏎ again places it. Esc returns to the fields."
      : "Fills right away against the real order book at today's prices. Uses no real money.";
  }

  const sellOff = !(cap > 0);
  const segKeys = (vals: readonly string[], cur: string, set: (v: string) => void) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const v = vals.find((x) => x !== cur)!;
    const b = e.currentTarget.querySelector(`[data-v="${v}"]`) as HTMLButtonElement | null;
    if (b && !b.disabled) { set(v); b.focus(); }
  };
  const showPrice = live || limitOn;
  const priceDis = (live && !loaded) || !editable;
  const amountShown = side === "BUY" ? "$" : "sh";

  return (
    <section className={`${css.pane} ${css.ticket} ${live ? css.liveT : ""}`} aria-label={live ? "trade ticket, live, real money" : "trade ticket, paper"}>
      <h2 className={css.ph}>
        {live ? <>Live order <span className={css.realMoney}>Real money</span></> : <>Paper order</>}
        <span className={css.r}>{live && <span className={css.dim}>{bs.word}</span>}<kbd>⇧T</kbd> focus</span>
      </h2>
      <p className={`${css.banner} ${live ? css.bannerLive : ""}`}>
        {live ? <>Live trading — real orders from your wallet. <button type="button" className={css.link} onClick={() => setMode("paper")} disabled={LIVE_BUSY.includes(phase.s)}>Switch to paper</button></>
          : <>Paper trading — fills against the real order book, no real money. Switch to Live in the header to use your wallet.</>}
        {mode === "paper" && live && <span className={css.warn}> Your live order is still being sent; paper trading resumes when it settles.</span>}
      </p>
      <form className={css.tk} onSubmit={(e) => e.preventDefault()}>
        <div className={css.seg} role="radiogroup" aria-label="Side" title="Buy opens or adds to a position. Sell closes shares you hold." onKeyDown={segKeys(["BUY", "SELL"], side, (v) => onSide(v as TradeSide))}>
          <button type="button" role="radio" data-v="BUY" aria-checked={side === "BUY"} tabIndex={side === "BUY" ? 0 : -1} className={css.w} disabled={!editable} onClick={() => onSide("BUY")}>Buy <kbd>B</kbd></button>
          <button type="button" role="radio" data-v="SELL" aria-checked={side === "SELL"} tabIndex={side === "SELL" ? 0 : -1} className={css.w} disabled={!editable || (sellOff && side !== "SELL")} onClick={() => onSide("SELL")}
            title={sellOff && side !== "SELL" ? `You hold no ${live ? "" : "paper "}${outcome} shares to sell` : undefined}>Sell <kbd>S</kbd></button>
        </div>
        <div className={css.seg} role="radiogroup" aria-label="Outcome" title={`YES pays $1 a share if the market resolves YES; NO pays $1 a share if it resolves NO.`} onKeyDown={segKeys(["YES", "NO"], outcome, (v) => onOutcome(v as Outcome))}>
          <button type="button" role="radio" data-v="YES" aria-checked={outcome === "YES"} tabIndex={outcome === "YES" ? 0 : -1} className={css.y} disabled={!editable} onClick={() => onOutcome("YES")}>YES <kbd>Y</kbd></button>
          <button type="button" role="radio" data-v="NO" aria-checked={outcome === "NO"} tabIndex={outcome === "NO" ? 0 : -1} className={css.nn} disabled={!editable} onClick={() => onOutcome("NO")}>NO <kbd>N</kbd></button>
        </div>

        <div className={css.fld}>
          <label htmlFor="tk-amount">
            <span>{side === "BUY" ? "Amount to spend · $" : "Shares to sell"}</span>
            <span>
              {side === "SELL" ? (cap > 0
                ? <button type="button" className={css.link} disabled={!editable} onClick={() => edit(() => setAmount(String(Math.floor(cap * 100) / 100)))} title="Sell everything you hold of this outcome">Max {sh(Math.floor(cap * 100) / 100)}</button>
                : <>none held</>)
                : live ? <>Balance {c.balance == null ? "—" : usd(c.balance)}</> : <>paper money</>}
            </span>
          </label>
          <div className={`${css.inp} ${!editable ? css.dis : ""} ${amount !== "" && amountErr && (live ? loaded : true) ? css.err : ""}`}>
            <input ref={amountEl} id="tk-amount" type="text" inputMode="decimal" autoComplete="off" value={amount} disabled={!editable} placeholder={side === "BUY" ? "50" : "0"}
              aria-invalid={amount !== "" && !!amountErr} aria-describedby="tk-amount-msg" onChange={(e) => NUM.test(e.target.value) && edit(() => setAmount(e.target.value))} onKeyDown={fieldKeys("amount")} />
            <span className={css.u}>{amountShown}</span>
          </div>
          <div id="tk-amount-msg">
            {amount !== "" && amountErr && (live ? loaded : true) ? <div className={css.ferr}>{amountErr}</div>
              : <div className={css.fhint}>{side === "BUY" ? `Dollars to spend. Each share pays $1 if ${outcome} wins.` : cap > 0 ? `You hold ${sh(cap)} ${outcome} shares${live ? " (not counting your open sell orders)" : " (paper)"}.` : `You hold no ${live ? "" : "paper "}${outcome} shares.`}</div>}
          </div>
        </div>

        {!live && !limitOn && (
          <p className={css.line}>
            <b className={css.txt}>Market order</b> — fills now at the best prices on the book.{" "}
            <button type="button" className={css.link} disabled={!editable} onClick={() => { setLimitOn(true); requestAnimationFrame(() => limitEl.current?.focus()); }}>Set a limit price</button>
          </p>
        )}
        {showPrice && (
          <div className={css.fld}>
            <label htmlFor="tk-limit">
              <span>{live ? "Limit price · ¢" : "Limit price (optional) · ¢"}</span>
              <span>{!live ? <button type="button" className={css.link} disabled={!editable} onClick={() => { setLimitOn(false); setHint(null); }}>Use market order</button>
                : tick == null ? "price step —" : <><kbd>↑</kbd><kbd>↓</kbd> step {cents(tick, tick)}¢ {"·"} <kbd>⇧</kbd> ×10</>}</span>
            </label>
            <div className={`${css.inp} ${priceDis ? css.dis : ""} ${price !== "" && errs.price ? css.err : ""}`}>
              <input ref={limitEl} id="tk-limit" type="text" inputMode="decimal" autoComplete="off" value={live && !loaded ? "—" : price} disabled={priceDis}
                aria-invalid={price !== "" && !!errs.price} aria-describedby="tk-limit-msg" onChange={(e) => NUM.test(e.target.value) && edit(() => setPrice(e.target.value))} onKeyDown={fieldKeys("limit")} />
              <span className={css.u}>¢</span>
            </div>
            <div id="tk-limit-msg">
              {(price !== "" || !live) && errs.price ? <div className={css.ferr}>{price === "" ? "Enter a limit price, or use a market order" : errs.price}</div> : offTick ? <div className={css.fhint}>{offTick}</div> : hint ? <div className={css.fhint}>{hint}</div>
                : <div className={css.fhint}>{side === "BUY" ? "Only fill at this price or lower" : "Only fill at this price or higher"}{live ? ". Prefilled with the best price on the book; anything unfilled waits on the book." : "."}</div>}
            </div>
          </div>
        )}

        {live ? loaded && <dl className={css.sum}>{summary.map(([k, v, cls]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className={cls}>{v}</dd></div>)}</dl>
          : est && <div className={css.est} aria-live="polite" title={`Estimate from the top ${book ? Math.max(book.asks.length, book.bids.length) : 0} price levels now; the fill uses a fresh copy of the book.`}>{est}</div>}

        <button ref={btn} type="button" className={`${css.go} ${goLook} ${armed && canSend ? css.armed : ""}`} disabled={goOff} aria-label={goAria}
          onClick={goAct} onBlur={() => setArmed(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); place(); }
            // Esc: disarm and go back to the field that armed it (stops the shell's global blur).
            if (e.key === "Escape" && armed) { e.stopPropagation(); setArmed(false); (lastField.current ?? amountEl.current)?.focus(); }
          }}>
          {goLabel}
        </button>
        <p className={css.line} aria-live="polite">{line}</p>
        {result && <p className={`${css.line} ${result.tone === "neg" ? css.neg : result.tone === "warn" ? css.warn : css.up}`} role="status" title={result.raw}>{result.text}</p>}
        {live && note && <p className={`${css.line} ${note.tone === "neg" ? css.neg : ""}`}>{note.text}</p>}
      </form>
    </section>
  );
});

"use client";
// TerminalTicket (DESIGN 11.6). Signed by the visitor's wallet, sent browser -> clob.polymarket.com. Gate and phase machine as TradeTicket.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Clob } from "../../hooks/useClob";
import { inInput } from "../../hooks/useGlobalKeys";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import { useOrderFlow, type OrderPhase } from "../../hooks/useOrderFlow";
import { isRejection, type Wallet } from "../../hooks/useWallet";
import type { PublicMarketDetail } from "../../lib/public";
import { loadVisitorSettings } from "../../lib/visitor/settings";
import { truncate } from "../fmt";
import { DEFAULT_TICK, onTick, quote, roundTick, sellQuote, ticketGate, validate, validateSell, type FieldErrors } from "./ticket";
import { cents, errMsg, forOutcome, nudge, sh, usd, type Outcome, type TradeSide } from "./book";
import { buttonState, type Action } from "./rules";
import css from "./terminal.module.css";

const NUM = /^\d*\.?\d*$/; // typing filter: digits and one dot
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export type TicketHandle = { focusLimit: () => void };
type Props = {
  /** The selected market (route id): a change resets the fields and the order view. */
  marketId: string | null;
  detail: PublicMarketDetail | null; feed: MarketFeed | null; noBook: boolean;
  side: TradeSide; outcome: Outcome; onSide: (s: TradeSide) => void; onOutcome: (o: Outcome) => void;
  /** Sellable shares of the chosen outcome's token (held minus own resting SELLs): the SELL cap. */
  held: number;
  /** A ladder click: copy `price` (0–1, the outcome's book) to Limit. `n` changes on every pick. */
  pick: { price: number; n: number } | null;
  wallet: Wallet & { clob: Clob };
  /** The order phase and whether side/outcome are locked, for the page's market-switch guard and B/S/Y/N keys. */
  onState: (s: { phase: OrderPhase["s"]; locked: boolean }) => void;
};

export const TerminalTicket = forwardRef<TicketHandle, Props>(function TerminalTicket({ marketId, detail, feed, noBook, side, outcome, onSide, onOutcome, held, pick, wallet: w, onState }, handle) {
  const c = w.clob;
  const btn = useRef<HTMLButtonElement>(null), limitEl = useRef<HTMLInputElement>(null), sharesEl = useRef<HTMLInputElement>(null);
  const [price, setPrice] = useState(""); // cents
  const [shares, setShares] = useState("");
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flow = useOrderFlow(w.exchange, c.refresh);
  const { phase, note, setNote } = flow;
  const [perTradeMax] = useState(() => loadVisitorSettings().limits.perTradeUsd);
  const lastField = useRef<HTMLInputElement | null>(null); // Esc on the armed button returns here
  useImperativeHandle(handle, () => ({ focusLimit: () => limitEl.current?.focus() }), []);

  const id = marketId;
  const tick = feed?.tickSize ?? null;
  const book = feed ? forOutcome(feed, outcome) : null;

  // Market switch: fresh fields and order view.
  const prefilled = useRef<string | null>(null), lastTick = useRef<number | null>(null);
  const { reset } = flow;
  useEffect(() => { setPrice(""); setShares(""); setHint(null); prefilled.current = null; lastTick.current = null; reset(); }, [id, reset]);

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
    setHint(`Rounded to tick ${cents(tick, tick)}¢`);
  }, [tick]); // only a tick change re-rounds

  useEffect(() => {
    if (!pick || tick == null) return;
    setPrice(cents(pick.price, tick));
    setHint(null);
    sharesEl.current?.focus();
  }, [pick]); // every pick, never on a tick change

  const gate = ticketGate({ wallet: w.status, chainOk: w.chainOk, credsReady: c.credsReady, approved: c.approved });
  const loaded = feed != null && tick != null && detail != null && detail.market.conditionId === id && feed.tokenId === detail.market.yesTokenId;
  const p01 = num(price) == null ? null : num(price)! / 100, n = num(shares);
  const tokenId = detail ? (outcome === "YES" ? detail.market.yesTokenId : detail.market.noTokenId) : null;
  const feeRate = detail?.market.feeRate ?? 0, feeExp = detail?.market.feeExponent ?? 1, minSh = feed?.minOrderSize ?? null;

  let errs: FieldErrors = {}, nShares: number | null = null, sendPrice: number | null = null;
  let summary: [string, string, string?][] = [];
  if (loaded) {
    sendPrice = p01 == null ? null : roundTick(side, p01, tick);
    if (side === "BUY") {
      const amount = p01 == null || n == null ? null : n * onTick(p01, tick);
      const q = p01 == null || amount == null ? null : quote(p01, amount, feeRate, tick, feeExp);
      errs = validate(p01, amount, c.balance, q, tick);
      if (!errs.amount && q && minSh != null && q.shares < minSh) errs.amount = `Minimum order is ${sh(minSh)} shares`;
      if (!errs.amount && q && q.maxLoss > perTradeMax) errs.amount = `Above your per-trade max $${perTradeMax}`;
      nShares = q?.shares ?? null;
      summary = [["Fee (max)", q ? usd(q.fee) : "—"], ["Max loss", q ? usd(q.maxLoss) : "—", css.down], [`Payout if ${outcome}`, q ? usd(q.payout) : "—", css.up]];
    } else {
      const q = p01 == null || n == null ? null : sellQuote(p01, n, feeRate, tick, feeExp);
      errs = validateSell({ price: p01, shares: n, held, tick, outcome, minShares: minSh });
      nShares = q?.shares ?? null;
      const show = q && !errs.shares; // over the cap: no proceeds for shares that can't be sold
      summary = [["Proceeds", show ? usd(q.proceeds) : "—", css.up], ["Fee (max)", show ? usd(q.fee) : "—"]];
    }
  }
  const shareErr = side === "BUY" ? errs.amount : errs.shares;
  const valid = loaded && !errs.price && !shareErr && nShares != null && sendPrice != null && !!tokenId;
  const canSend = gate === null && phase.s === "idle" && valid;
  const editable = (phase.s === "idle" || phase.s === "error");
  useEffect(() => onState({ phase: phase.s, locked: !editable }), [phase.s, editable, onState]);
  const verb = side === "BUY" ? "Buy" : "Sell";
  const orderText = valid ? `${verb} ${sh(nShares!)} ${outcome} at ${cents(sendPrice, tick!)}¢` : "";
  const offTick = loaded && p01 != null && Math.abs(roundTick(side, p01, tick) - p01) > 1e-9
    ? `Not on tick ${cents(tick, tick)}¢ — rounds ${side === "BUY" ? "down" : "up"} to ${cents(roundTick(side, p01, tick), tick)}` : null;

  const edit = (f: () => void) => { setNote(null); setHint(null); f(); };
  // Focus after the re-render: the button is still disabled when the send or wallet prompt resolves (DESIGN 10.7).
  const [focusReq, setFocusReq] = useState(0);
  const refocus = () => setFocusReq((n) => n + 1);
  useEffect(() => {
    if (!focusReq || phase.s === "signing" || phase.s === "checking") return;
    const b = btn.current;
    (b && !b.disabled ? b : lastField.current ?? limitEl.current)?.focus();
  }, [focusReq, phase.s]);
  const place = async () => {
    if (!canSend) return;
    setArmed(false);
    await flow.place({ side, tokenId: tokenId!, price: p01!, shares: nShares!, tick: tick! });
    refocus();
  };
  const run = async (f: () => Promise<void>, rejected: string) => {
    setBusy(true);
    setNote(null);
    try { await f(); }
    catch (e) { setNote(isRejection(e) ? { text: rejected, tone: "muted" } : { text: truncate(errMsg(e), 120), tone: "neg" }); }
    finally { setBusy(false); refocus(); }
  };
  // Leaving "unknown" clears the shares: no one-click identical resend.
  const startOver = () => { flow.reset(); setShares(""); };
  const newOrder = () => { flow.reset(); setShares(""); prefilled.current = null; };

  // ⏎ arms (focuses the submit in review), ⌘⏎ / Ctrl⏎ signs; ↑↓ nudge (DESIGN 11.5).
  const fieldKeys = (which: "limit" | "shares") => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      lastField.current = e.currentTarget;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) void place();
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
      const step = minSh ?? 1;
      edit(() => setShares(String(Math.max(0, Math.round(((n ?? 0) + dir * k * step) * 100) / 100))));
    }
  };

  // X cancels the ticket's order when no open-orders row has focus (that row handles its own X).
  useEffect(() => {
    if (phase.s !== "open") return;
    const h = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== "x" && e.key !== "X") || e.metaKey || e.ctrlKey || e.altKey || inInput(e)) return;
      if ((document.activeElement as HTMLElement | null)?.closest("[data-order-row]")) return;
      void flow.cancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [phase.s, flow]);

  const bs = buttonState({
    loaded, noBook, gate, wallet: w.status, signing: c.enabling || c.approving || busy, allowanceError: c.error,
    phase, valid, armed: armed && canSend, outcome, orderText, c: (p) => cents(p, tick ?? DEFAULT_TICK),
  });
  const act: Record<Action, () => void> = {
    connect: () => void w.connect(), switchChain: () => void w.switchChain(),
    enable: () => void run(c.enable, "You rejected the signature. Trading stays off."),
    approve: () => void run(c.approve, "You rejected the transaction. Nothing was approved."),
    place: () => void place(), cancel: () => void flow.cancel(), newOrder, recheck: () => void flow.recheck(), reset: flow.reset,
  };
  const links = { retryAllowance: ["Retry check", () => void c.checkApproval().catch(() => {})], startOver: ["Start over", startOver] } as const;
  const look = { off: css.off, act: css.act, connect: css.connect, yes: css.yes, no: css.no }[bs.look];
  const aria = bs.action === "place" ? (side === "BUY"
    ? `Sign and place order: buy ${outcome} ${sh(nShares!)} shares at ${cents(sendPrice, tick!)} cents, up to ${summary[1]![1]}`
    : `Sign and place order: sell ${outcome} ${sh(nShares!)} shares at ${cents(sendPrice, tick!)} cents, proceeds about ${summary[0]![1]}`) : undefined;
  let line: ReactNode = null;
  if (bs.line) {
    const l = bs.line, link = l.link ? links[l.link] : null;
    const body = <>{l.text}{link && <> <button type="button" className={css.link} onClick={link[1]}>{link[0]}</button></>}</>;
    line = <span className={l.tone === "neg" ? css.down : l.tone === "up" ? css.up : undefined} title={phase.s === "error" ? phase.msg : undefined}>{body}</span>;
  }

  const tickTxt = tick == null ? "tick —" : `${cents(tick, tick)}`;
  const sellOff = !(held > 0);
  const segKeys = (vals: readonly string[], cur: string, set: (v: string) => void) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const v = vals.find((x) => x !== cur)!;
    const b = e.currentTarget.querySelector(`[data-v="${v}"]`) as HTMLButtonElement | null;
    if (b && !b.disabled) { set(v); b.focus(); }
  };

  return (
    <section className={`${css.pane} ${css.ticket}`} aria-label="trade ticket">
      <h2 className={css.ph}>Order · limit <span className={css.r}><span className={css.dim}>{bs.word}</span><kbd>⇧T</kbd> focus</span></h2>
      <form className={css.tk} onSubmit={(e) => e.preventDefault()}>
        <div className={css.seg} role="radiogroup" aria-label="Side" onKeyDown={segKeys(["BUY", "SELL"], side, (v) => onSide(v as TradeSide))}>
          <button type="button" role="radio" data-v="BUY" aria-checked={side === "BUY"} tabIndex={side === "BUY" ? 0 : -1} className={css.w} disabled={!editable} onClick={() => onSide("BUY")}>Buy <kbd>B</kbd></button>
          <button type="button" role="radio" data-v="SELL" aria-checked={side === "SELL"} tabIndex={side === "SELL" ? 0 : -1} className={css.w} disabled={!editable || (sellOff && side !== "SELL")} onClick={() => onSide("SELL")}>Sell <kbd>S</kbd></button>
        </div>
        <div className={css.seg} role="radiogroup" aria-label="Outcome" onKeyDown={segKeys(["YES", "NO"], outcome, (v) => onOutcome(v as Outcome))}>
          <button type="button" role="radio" data-v="YES" aria-checked={outcome === "YES"} tabIndex={outcome === "YES" ? 0 : -1} className={css.y} disabled={!editable} onClick={() => onOutcome("YES")}>YES <kbd>Y</kbd></button>
          <button type="button" role="radio" data-v="NO" aria-checked={outcome === "NO"} tabIndex={outcome === "NO" ? 0 : -1} className={css.nn} disabled={!editable} onClick={() => onOutcome("NO")}>NO <kbd>N</kbd></button>
        </div>
        {sellOff && <p className={css.line}>No {outcome} shares to sell</p>}

        <div className={css.fld}>
          <label htmlFor="tk-limit"><span>Limit · ¢</span><span>{tick == null ? tickTxt : <><kbd>↑</kbd><kbd>↓</kbd> {tickTxt} · <kbd>⇧</kbd> ×10</>}</span></label>
          <div className={`${css.inp} ${!loaded || !editable ? css.dis : ""} ${loaded && price !== "" && errs.price ? css.err : ""}`}>
            <input ref={limitEl} id="tk-limit" type="text" inputMode="decimal" autoComplete="off" value={loaded ? price : "—"} disabled={!loaded || !editable}
              aria-invalid={loaded && price !== "" && !!errs.price} aria-describedby="tk-limit-msg" onChange={(e) => NUM.test(e.target.value) && edit(() => setPrice(e.target.value))} onKeyDown={fieldKeys("limit")} />
            <span className={css.u}>¢</span>
          </div>
          <div id="tk-limit-msg">
            {loaded && price !== "" && errs.price ? <div className={css.ferr}>{errs.price}</div> : offTick ? <div className={css.fhint}>{offTick}</div> : hint ? <div className={css.fhint}>{hint}</div> : null}
          </div>
        </div>

        <div className={css.fld}>
          <label htmlFor="tk-shares"><span>Shares</span><span>
            {loaded && n != null && p01 != null && <>= <span className={css.n} style={{ color: "var(--t-text)" }}>{usd(n * roundTick(side, p01, tick))}</span> · </>}
            Balance {c.balance == null ? "—" : usd(c.balance)}
          </span></label>
          <div className={`${css.inp} ${!editable ? css.dis : ""} ${loaded && shares !== "" && shareErr ? css.err : ""}`}>
            <input ref={sharesEl} id="tk-shares" type="text" inputMode="decimal" autoComplete="off" value={shares} disabled={!editable}
              aria-invalid={loaded && shares !== "" && !!shareErr} aria-describedby="tk-shares-msg" onChange={(e) => NUM.test(e.target.value) && edit(() => setShares(e.target.value))} onKeyDown={fieldKeys("shares")} />
            <span className={css.u}>sh <kbd>Tab</kbd></span>
          </div>
          <div id="tk-shares-msg">{loaded && shares !== "" && shareErr && <div className={css.ferr}>{shareErr}</div>}</div>
        </div>

        {loaded && <dl className={css.sum}>{summary.map(([k, v, cls]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className={cls}>{v}</dd></div>)}</dl>}

        <button ref={btn} type="button" className={`${css.go} ${look} ${armed && canSend ? css.armed : ""}`} disabled={bs.off} aria-label={aria}
          onClick={bs.action ? act[bs.action] : undefined} onBlur={() => setArmed(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void place(); }
            // Esc: disarm and go back to the field that armed it (stops the shell's global blur).
            if (e.key === "Escape" && armed) { e.stopPropagation(); setArmed(false); (lastField.current ?? limitEl.current)?.focus(); }
          }}>
          {bs.spin && <span className={css.spin} aria-hidden />}{bs.label}{bs.kbd.map((k) => <kbd key={k}>{k}</kbd>)}
        </button>
        <p className={css.line} aria-live="polite">{line}</p>
        {note && <p className={`${css.line} ${note.tone === "neg" ? css.neg : ""}`}>{note.text}</p>}
      </form>
    </section>
  );
});

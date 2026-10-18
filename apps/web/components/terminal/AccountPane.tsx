"use client";
import { useState, type KeyboardEvent } from "react";
import type { Clob } from "../../hooks/useClob";
import { cents, errMsg, sh, usd, type Outcome } from "./book";
import css from "./terminal.module.css";

export type TokenInfo = { conditionId: string; question: string; outcome: Outcome };
export type AccountTab = "positions" | "orders";
const shortTok = (t: string) => `token ${t.slice(0, 6)}…${t.slice(-4)}`;

type Props = {
  clob: Clob; connected: boolean; tab: AccountTab; onTab: (t: AccountTab) => void;
  /** tokenId -> market, for markets loaded in this session (positions and orders only carry a token id). */
  tokens: Map<string, TokenInfo>;
  /** tokenId -> mark (0–1): feed mid for the selected market, watchlist midNow for others. */
  mark: (tokenId: string) => number | null; tick: number;
};

/** Positions / Open orders (DESIGN 11.4). Cancel has no confirm: no money moves. `X` on a focused order row cancels it. */
export function AccountPane({ clob: c, connected, tab, onTab, tokens, mark, tick }: Props) {
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const positions = Object.entries(c.positions).filter(([, n]) => n > 0);
  const cancel = async (id: string) => {
    setCancelling((s) => new Set(s).add(id));
    setErr(null);
    try { await c.cancel([id]); } catch (e) { setErr(`Cancel failed: ${errMsg(e)}`); }
    finally { setCancelling((s) => { const x = new Set(s); x.delete(id); return x; }); }
  };
  const rowKeys = (id: string) => (e: KeyboardEvent) => { if ((e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void cancel(id); } };
  const name = (t: string) => tokens.get(t)?.question ?? shortTok(t);
  const tag = (t: string) => { const o = tokens.get(t)?.outcome; return o ? <span className={`${css.tag} ${o === "YES" ? css.yes : css.no}`}>{o}</span> : "—"; };

  let body;
  if (!connected) body = <p className={`${css.line} ${css.msg}`}>Connect wallet to see positions</p>;
  else if (!c.credsReady) body = <p className={`${css.line} ${css.msg}`}>Enable trading in the ticket to load your orders and positions.</p>;
  else if (c.lastAt == null && !c.error) body = <p className={`${css.line} ${css.msg}`} role="status">Loading positions…</p>;
  else if (tab === "positions") {
    body = positions.length ? (
      <table aria-label="positions">
        <thead><tr><th>Market</th><th>Outcome</th><th>Shares</th><th>Mark</th><th>Value</th></tr></thead>
        <tbody>
          {positions.map(([t, n]) => { const m = mark(t); return (
            <tr key={t}><td className={css.q} title={name(t)}>{name(t)}</td><td>{tag(t)}</td><td>{sh(n)}</td><td>{m == null ? "—" : `${cents(m, tick)}¢`}</td><td>{m == null ? "—" : usd(n * m)}</td></tr>
          ); })}
        </tbody>
      </table>
    ) : <p className={`${css.line} ${css.msg}`}>No positions.</p>;
  } else {
    body = c.orders.length ? (
      <table aria-label="open orders">
        <thead><tr><th>Market</th><th>Outcome</th><th>Side</th><th>Shares</th><th>Limit</th><th>Filled</th><th /></tr></thead>
        <tbody>
          {c.orders.map((o) => (
            <tr key={o.orderId} tabIndex={0} data-order-row onKeyDown={rowKeys(o.orderId)}>
              <td className={css.q} title={name(o.tokenId)}>{name(o.tokenId)}</td><td>{tag(o.tokenId)}</td>
              <td className={o.side === "BUY" ? css.up : css.down}>{o.side}</td><td>{sh(o.shares)}</td><td>{cents(o.price, tick)}¢</td><td>{sh(o.filled)}/{sh(o.shares)}</td>
              <td>{cancelling.has(o.orderId) ? <span className={css.dim}>cancelling…</span> : <button type="button" onClick={() => void cancel(o.orderId)} aria-label={`Cancel order ${o.orderId.slice(0, 8)}`}>Cancel <kbd>X</kbd></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : <p className={`${css.line} ${css.msg}`}>No open orders.</p>;
  }

  const t = (id: AccountTab, label: string, n: number) => (
    <button type="button" role="tab" aria-selected={tab === id} className={css.tab} onClick={() => onTab(id)}>{label} <span className={css.dim}>{connected && c.credsReady ? n : ""}</span></button>
  );
  return (
    <section className={`${css.pane} ${css.acct}`} aria-label="account">
      <div className={css.ph} role="tablist">{t("positions", "Positions", positions.length)}{t("orders", "Open orders", c.orders.length)}<span className={css.r}><kbd>P</kbd><kbd>O</kbd> tabs · <kbd>X</kbd> cancel row</span></div>
      <div className={css.scroll} role="tabpanel">
        {connected && c.error && <p className={`${css.line} ${css.neg} ${css.msg}`} role="alert">{c.error} <button type="button" className={css.link} onClick={() => void c.refresh()}>Retry</button></p>}
        {err && <p className={`${css.line} ${css.neg} ${css.msg}`} role="alert">{err}</p>}
        {body}
      </div>
    </section>
  );
}

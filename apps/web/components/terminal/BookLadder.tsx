"use client";
import { forwardRef, useRef, type KeyboardEvent } from "react";
import type { OpenOrder } from "@pm/pm/exchange";
import type { FeedLevel, FeedStatus, MarketFeed } from "../../hooks/useMarketFeed";
import { hms } from "../fmt";
import { DEFAULT_TICK } from "./ticket";
import { PaneSkeleton } from "./PaneSkeleton";
import { cents, changedSizes, sh, type Outcome } from "./book";
import css from "./terminal.module.css";

type Row = { kind: "ask" | "bid"; level: FeedLevel; i: number };
const key = (p: number) => p.toFixed(6);

type Props = {
  /** The chosen outcome's book (mirrored for NO); null = no data yet. */
  book: MarketFeed | null; status: FeedStatus; noBook: boolean; outcome: Outcome; ownOrders: OpenOrder[];
  /** Resets the tint diff (market or outcome switch). */
  viewKey: string; /** Row index of the price cursor; -1 = best bid. */
  cursor: number; onCursor: (i: number) => void; onPick: (price: number) => void;
};

/** 15 levels per side, asks above (best nearest the spread), bids below. A grid with roving tabindex on the price cells (DESIGN 11.8). */
export const BookLadder = forwardRef<HTMLTableElement, Props>(function BookLadder({ book, status, noBook, outcome, ownOrders, viewKey, cursor, onCursor, onPick }, ref) {
  // Tint diff against the previous payload of the same view; the first payload after a switch tints nothing.
  const prev = useRef<{ view: string; at: number; bids: FeedLevel[]; asks: FeedLevel[]; tint: Set<number> } | null>(null);
  let tint = new Set<number>();
  if (book) {
    const p = prev.current?.view === viewKey ? prev.current : null;
    if (p && p.at === book.at) tint = p.tint;
    else {
      const b = changedSizes(p?.bids ?? null, book.bids), a = changedSizes(p?.asks ?? null, book.asks);
      tint = new Set([...b, ...a]);
      prev.current = { view: viewKey, at: book.at, bids: book.bids, asks: book.asks, tint };
    }
  }

  const tick = book?.tickSize ?? DEFAULT_TICK;
  const rows: Row[] = book ? [...book.asks.map((l, i) => ({ kind: "ask" as const, level: l, i })).reverse(), ...book.bids.map((l, i) => ({ kind: "bid" as const, level: l, i }))] : [];
  const max = Math.max(1, ...rows.map((r) => r.level.size));
  const mine = (side: "BUY" | "SELL", p: number) => ownOrders.filter((o) => o.side === side && key(o.price) === key(p)).reduce((a, o) => a + o.shares - o.filled, 0);
  const cur = Math.min(Math.max(0, cursor < 0 ? book?.asks.length ?? 0 : cursor), Math.max(0, rows.length - 1)); // -1 = best bid
  const bid = book?.bids[0]?.price, ask = book?.asks[0]?.price;
  const badge = status === "stale" ? <span className={`${css.badge} ${css.stale}`}><i aria-hidden />stale</span>
    : status === "error" && book ? <span className={`${css.badge} ${css.error}`}><i aria-hidden />feed error</span>
    : status === "loading" ? <span className={css.spin} aria-label="loading" /> : null;

  const keys = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = Math.min(rows.length - 1, Math.max(0, cur + (e.key === "ArrowDown" ? 1 : -1)));
      onCursor(n);
      (e.currentTarget.querySelector(`[data-row="${n}"]`) as HTMLElement | null)?.focus();
    } else if (e.key === "Enter" && rows[cur]) { e.preventDefault(); onPick(rows[cur].level.price); }
  };

  let body;
  if (!book) {
    body = noBook ? <p className={`${css.line} ${css.msg}`}>No live book for this market.</p>
      : status === "error" ? <p className={`${css.line} ${css.neg} ${css.msg}`}>Feed error · retrying</p>
      : <PaneSkeleton />;
  } else {
    body = (
      <table ref={ref} role="grid" aria-label={`Order book, ${outcome}, in cents`} onKeyDown={keys}>
        <thead><tr><th style={{ textAlign: "left" }}>Mine</th><th>Bid</th><th style={{ textAlign: "center" }}>Price ¢</th><th style={{ textAlign: "left" }}>Ask</th><th>Mine</th></tr></thead>
        <tbody>
          {rows.flatMap((r, n) => {
            const p = r.level.price, my = mine(r.kind === "bid" ? "BUY" : "SELL", p), t = tint.has(p);
            const size = <span key={`${key(p)}:${r.level.size}`} className={t ? css.tint : undefined}>{sh(r.level.size)}</span>;
            const bar = <i className={css.bar} style={{ width: `${(r.level.size / max) * 100}%` }} aria-hidden />;
            const tr = (
              <tr key={`${r.kind}${r.i}`} className={`${css[r.kind]} ${n === cur ? css.cur : ""} ${r.i >= 10 ? css.far : ""}`} onClick={() => { onCursor(n); onPick(p); }}>
                <td className={css.my}>{r.kind === "bid" && my > 0 ? `+${sh(my)}` : ""}</td>
                <td className={css.bs}>{r.kind === "bid" && <>{bar}{size}</>}</td>
                <td className={css.px} role="gridcell" tabIndex={n === cur ? 0 : -1} data-row={n} aria-label={`${r.kind} ${cents(p, tick)} cents, size ${sh(r.level.size)}`}>{cents(p, tick)}</td>
                <td className={css.as}>{r.kind === "ask" && <>{bar}{size}</>}</td>
                <td className={css.my}>{r.kind === "ask" && my > 0 ? `+${sh(my)}` : ""}</td>
              </tr>
            );
            return r.kind === "bid" && r.i === 0
              ? [<tr key="spr" className={css.spr}><td colSpan={5}>last <b>{cents(book.last, tick)}</b> &nbsp;·&nbsp; spread {bid != null && ask != null ? cents(ask - bid, tick) : "—"}¢ &nbsp;·&nbsp; mid {cents(book.mid, tick)}</td></tr>, tr]
              : [tr];
          })}
        </tbody>
      </table>
    );
  }

  return (
    <section className={`${css.pane} ${css.ladder}`} aria-label="order book">
      <h2 className={css.ph}>Order book · {outcome} <span className={css.r}>{badge}{book && <>click price · <kbd>L</kbd></>}</span></h2>
      <div className={css.lbody}>{body}</div>
      <div className={css.lfoot}><span>15 levels per side</span><span style={{ marginLeft: "auto" }}>{book ? `book ${hms(book.at)}` : "book —"}</span></div>
    </section>
  );
});

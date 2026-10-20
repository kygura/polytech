"use client";
import type { KeyboardEvent, RefObject } from "react";
import type { PublicWatchRow } from "../../lib/public";
import { PaneSkeleton } from "./PaneSkeleton";
import { DISCLAIMER } from "./ticket";
import css from "./terminal.module.css";

// Rows carry no tick: whole cents, else one decimal.
const c = (p: number | null) => (p == null ? "—" : `${(p * 100).toFixed(Math.abs(p * 100 - Math.round(p * 100)) < 1e-6 ? 0 : 1)}¢`);

type Props = {
  rows: PublicWatchRow[]; loading: boolean; error: string | null; empty: string;
  cats: string[]; cat: string | null; onCat: (c: string | null) => void;
  selectedId: string | null; cursorId: string | null; onSelect: (id: string) => void; open: boolean;
  /** Why switching is blocked right now (an order is mid-send), shown above the rows. */
  note: string | null;
  /** The list's filter box (the `/` target on this page). */
  query: string; onQuery: (q: string) => void; searchRef: RefObject<HTMLInputElement | null>; onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
};

/** Watchlist rows (DESIGN 11.4). Overlay drawer under 1360px (`open`). */
export function MarketList({ rows, loading, error, empty, cats, cat, onCat, selectedId, cursorId, onSelect, open, note, query, onQuery, searchRef, onSearchKey }: Props) {
  return (
    <nav className={`${css.pane} ${css.list} ${open ? css.open : ""}`} aria-label="Markets">
      <h2 className={css.ph}>Markets <span className={css.r}><kbd>J</kbd><kbd>K</kbd><kbd>⏎</kbd></span></h2>
      <div className={css.filterBox}>
        <input ref={searchRef} data-filter type="search" placeholder="Filter markets" aria-label="Filter markets" value={query}
          onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKey} />
      </div>
      {cats.length > 0 && (
        <div className={css.cats}>
          {[null, ...cats].map((x) => <button key={x ?? "all"} type="button" aria-pressed={cat === x} onClick={() => onCat(x)}>{x ?? "All"}</button>)}
        </div>
      )}
      {note && <p className={`${css.line} ${css.msg}`} role="status" style={{ padding: "6px 12px", flex: "none" }}>{note}</p>}
      <div className={css.rows} data-market-list>
        {loading && !rows.length ? <PaneSkeleton label="Loading watchlist…" />
          : error && !rows.length ? <p className={`${css.line} ${css.neg} ${css.msg}`} role="alert">Could not load the watchlist. Retrying in 60 s.</p>
          : !rows.length ? <p className={`${css.line} ${css.msg}`}>{empty}</p>
          : rows.map((r) => (
            <button key={r.conditionId} type="button" id={`mrow-${r.conditionId}`} aria-current={r.conditionId === selectedId ? "true" : undefined}
              className={`${css.mrow} ${r.conditionId === selectedId ? css.sel : ""} ${r.conditionId === cursorId ? css.cur : ""}`} onClick={() => onSelect(r.conditionId)}>
              <span className={css.q} title={r.question}>{r.question}</span>
              <span className={`${css.n} ${css.px}`}>{c(r.midNow)}</span>
              <span className={css.sub}>{r.category ?? "—"}</span>
              <span className={`${css.n} ${css.sub}`} style={{ textAlign: "right" }}>{Math.max(0, Math.round(r.daysLeft))}d</span>
            </button>
          ))}
      </div>
      <p className={css.disc}>{DISCLAIMER}</p>
    </nav>
  );
}

"use client";
import { DISCLAIMER } from "../public/PublicShell";
import { daysShort, pc, SORTS, volShort, type ListMode, type ListRow, type SortKey } from "./marketQuery";
import { PaneSkeleton } from "./PaneSkeleton";
import css from "./terminal.module.css";

type Props = {
  mode: ListMode; onMode: (m: ListMode) => void;
  rows: ListRow[]; total: number | null; loading: boolean; error: string | null; empty: string;
  cats: string[]; cat: string | null; onCat: (c: string | null) => void;
  sort: SortKey; onSort: (s: SortKey) => void;
  selectedId: string | null; cursorId: string | null; onSelect: (id: string) => void; open: boolean;
  /** Why switching is blocked right now (an order is mid-send), shown above the rows. */
  note: string | null;
};

/** Watchlist or every open market (DESIGN 11.4). Full titles, YES / NO prices and a probability bar per row. Overlay drawer under 1360px (`open`). */
export function MarketList({ mode, onMode, rows, total, loading, error, empty, cats, cat, onCat, sort, onSort, selectedId, cursorId, onSelect, open, note }: Props) {
  return (
    <nav className={`${css.pane} ${css.list} ${open ? css.open : ""}`} aria-label="Markets">
      <div className={css.ph} role="tablist" aria-label="Market list">
        {(["watch", "all"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={css.tab} onClick={() => onMode(m)}>{m === "watch" ? "Watchlist" : "All markets"}</button>
        ))}
        <span className={css.r}><kbd>J</kbd><kbd>K</kbd><kbd>⏎</kbd></span>
      </div>
      {mode === "watch" ? (cats.length > 0 && (
        <div className={css.cats}>
          {[null, ...cats].map((x) => <button key={x ?? "all"} type="button" aria-pressed={cat === x} onClick={() => onCat(x)}>{x ?? "All"}</button>)}
        </div>
      )) : (
        <div className={css.cats} role="radiogroup" aria-label="Sort">
          {SORTS.map((s) => <button key={s.value} type="button" role="radio" aria-checked={sort === s.value} aria-pressed={sort === s.value} onClick={() => onSort(s.value)}>{s.label}</button>)}
          <span className={css.count}>{total == null ? "" : `${rows.length}${total > rows.length ? ` of ${total.toLocaleString("en-US")}` : ""}`}</span>
        </div>
      )}
      {note && <p className={`${css.line} ${css.msg}`} role="status" style={{ padding: "6px 12px", flex: "none" }}>{note}</p>}
      <div className={css.rows} data-market-list>
        {loading && !rows.length ? <PaneSkeleton label={mode === "watch" ? "Loading watchlist…" : "Querying markets…"} />
          : error && !rows.length ? <p className={`${css.line} ${css.neg} ${css.msg}`} role="alert">{error}</p>
          : !rows.length ? <p className={`${css.line} ${css.msg}`}>{empty}</p>
          : rows.map((r) => {
            const vol = volShort(r.vol24h);
            return (
              <button key={r.conditionId} type="button" id={`mrow-${r.conditionId}`} aria-current={r.conditionId === selectedId ? "true" : undefined}
                className={`${css.mrow} ${r.conditionId === selectedId ? css.sel : ""} ${r.conditionId === cursorId ? css.cur : ""}`} onClick={() => onSelect(r.conditionId)}>
                <span className={css.q} title={r.question}>{r.question}</span>
                <span className={css.odds}>
                  <span className={css.yes}>{pc(r.yes)}</span>
                  <span className={css.no}>{pc(r.yes == null ? null : 1 - r.yes)}</span>
                </span>
                <span className={css.sub}>{[r.category, daysShort(r.daysLeft), vol && `${vol} 24h`].filter(Boolean).join(" · ")}</span>
                <span className={css.pbar} aria-hidden><i style={{ width: `${r.yes == null ? 0 : r.yes * 100}%` }} /></span>
              </button>
            );
          })}
      </div>
      <p className={css.disc}>{DISCLAIMER}</p>
    </nav>
  );
}

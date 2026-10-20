"use client";
import type { KeyboardEvent, RefObject } from "react";
import { Chip, ErrorBar, Panel, PricePill } from "../ui";
import { PaneSkeleton } from "./PaneSkeleton";
import { changeLabel, daysLabel, emptyCopy, staleRow, volLabel, wideRow, type Facet, type ListRow } from "./marketList";
import { DISCLAIMER } from "./ticket";
import css from "./terminal.module.css";

type Props = {
  rows: ListRow[]; total: number; loading: boolean; error: boolean; onRetry: () => void; now: number;
  cats: Facet[]; cat: string | null; onCat: (c: string | null) => void;
  selectedId: string | null; cursorId: string | null; onSelect: (id: string) => void; open: boolean;
  /** The selected market's live YES display price (feed): the pill of that row, so list and header agree. */
  live: { id: string; price: number | null } | null;
  /** Why switching is blocked right now (an order is mid-send), shown above the rows. */
  note: string | null;
  /** The list's filter box (the `/` target on this page). */
  query: string; onQuery: (q: string) => void; searchRef: RefObject<HTMLInputElement | null>; onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
};

/** All tracked markets, searchable by name (DESIGN 13.4). Pinned and watched rows first. Overlay drawer under 1280px (`open`). */
export function MarketList({ rows, total, loading, error, onRetry, now, cats, cat, onCat, selectedId, cursorId, onSelect, open, live, note, query, onQuery, searchRef, onSearchKey }: Props) {
  return (
    <Panel as="nav" title="Markets" label="Markets" className={`${css.list} ${open ? css.open : ""}`}
      right={<>{total > rows.length ? <span className={css.n}>{rows.length} of {total.toLocaleString("en-US")}</span> : null}<kbd>J</kbd><kbd>K</kbd><kbd>{"⏎"}</kbd></>}>
      <div className={css.listInner}>
        <div className={css.filterBox}>
          <input ref={searchRef} data-filter type="search" placeholder="Filter markets" aria-label="Filter markets" value={query}
            onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKey} />
        </div>
        {cats.length > 0 && (
          <div className={css.cats} role="group" aria-label="Category">
            {[null, ...cats.map((x) => x.category)].map((x) => <Chip key={x ?? "all"} pressed={cat === x} onClick={() => onCat(x)}>{x ?? "All"}</Chip>)}
          </div>
        )}
        {note && <p className={`${css.line} ${css.msg}`} role="status" style={{ padding: "6px 12px", flex: "none" }}>{note}</p>}
        <div className={css.rows} data-market-list>
          {loading && !rows.length ? <PaneSkeleton label="Loading markets…" />
            : error ? <ErrorBar message="Could not load markets. Retrying…" onRetry={onRetry} />
            : !rows.length ? <p className={`${css.line} ${css.msg}`}>{emptyCopy(query, cat)}</p>
            : rows.map((r) => {
              const isLive = live?.id === r.conditionId, price = isLive ? live.price : r.mid;
              const ch = changeLabel(r.d24c), vol = volLabel(r.vol24h), wide = !isLive && wideRow(r);
              const sub = [r.category, daysLabel(r.endDate, now), vol].filter(Boolean).join(" · ");
              return (
                <button key={r.conditionId} type="button" id={`mrow-${r.conditionId}`} aria-current={r.conditionId === selectedId ? "true" : undefined}
                  className={`${css.mrow} ${r.conditionId === selectedId ? css.sel : ""} ${r.conditionId === cursorId ? css.cur : ""} ${staleRow(r, now) ? css.old : ""}`} onClick={() => onSelect(r.conditionId)}>
                  <span className={css.q} title={r.question}>{r.question}</span>
                  <span className={css.px} title={wide ? "Wide book (> 10¢): this is the midpoint, not a trade price" : undefined}>
                    <PricePill outcome="YES" price={price} />{wide && <span className={css.wide} aria-label="wide book">~</span>}
                  </span>
                  <span className={css.sub}>{sub || "—"}</span>
                  <span className={`${css.n} ${css.chg} ${ch.dir === "up" ? css.up : ch.dir === "down" ? css.down : css.dim}`} title="24h change in YES, cents">{ch.text}</span>
                </button>
              );
            })}
        </div>
        <p className={css.disc}>{DISCLAIMER}</p>
      </div>
    </Panel>
  );
}

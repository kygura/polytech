"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import css from "./DataTable.module.css";
import { inInput } from "../hooks/useGlobalKeys";
import { minTableWidth, scrollTopForRow, virtualWindow, type VirtualOpts } from "./virtual";

export type { VirtualOpts };

export type Column<T> = { id: string; header: ReactNode; align: "l" | "r"; sortable?: boolean; width?: string; /** virtual mode: floor for a flex (width-less) column */ minWidth?: string; cell: (row: T) => ReactNode; title?: string };
export type Sort = { id: string; dir: "asc" | "desc" };

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: Sort;
  /** `additive` is true on shift-click (secondary sort key). */
  onSort?: (s: Sort, additive?: boolean) => void;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onOpen?: (row: T) => void;
  renderExpanded?: (row: T) => ReactNode;
  /** Stale data: all cells drop to --muted. */
  muted?: boolean;
  /** Keys j/k/Enter bound while true (default). Set false when two tables share a view. */
  keys?: boolean;
  label?: string;
  /** Extra class per row (e.g. the one allowed flash on new pods). */
  rowClass?: (row: T) => string | undefined;
  /** Opt-in windowing for long lists: fixed-height rows, every column needs a `width`, only the visible slice renders between two spacer rows. `renderExpanded` is ignored. */
  virtual?: VirtualOpts;
  /** Inside a Panel: drop the table's own border, radius and background (the Panel is the frame). */
  flush?: boolean;
};

/** The one table. Real <table>, sticky header, aria-sort buttons, j/k/Enter, selection bar. */
export function DataTable<T>({ columns, rows, rowKey, sort, onSort, selectedKey, onSelect, onOpen, renderExpanded, muted, keys = true, label, rowClass, virtual, flush }: DataTableProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const idx = selectedKey == null ? -1 : rows.findIndex((r) => rowKey(r) === selectedKey);

  const rh = virtual?.rowHeight ?? 0;
  const win = virtual ? virtualWindow({ scrollTop: scroll.top, viewport: scroll.h, rowHeight: rh, overscan: virtual.overscan, count: rows.length }) : null;
  const onWindow = virtual?.onWindow;
  useEffect(() => {
    if (!virtual) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => setScroll((s) => (s.top === el.scrollTop && s.h === el.clientHeight ? s : { top: el.scrollTop, h: el.clientHeight }));
    measure();
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); el.removeEventListener("scroll", onScroll); ro.disconnect(); };
  }, [!!virtual]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (win) onWindow?.({ start: win.start, end: win.end }); }, [win?.start, win?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!keys) return;
    const h = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Enter on a button/link/menu item (a sort header, the view menu) activates that control; it does not also open the selected row
      if (e.key === "Enter" && (e.target as HTMLElement | null)?.closest("button, a, summary, [role^=menuitem], dialog")) return;
      if (e.key === "j" || e.key === "k") {
        if (!rows.length) return;
        const n = e.key === "j" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
        onSelect?.(rowKey(rows[n]!));
        const el = ref.current;
        if (virtual && el) {
          const t = scrollTopForRow({ index: n, scrollTop: el.scrollTop, viewport: el.clientHeight, rowHeight: rh });
          if (t != null) el.scrollTop = t;
        } else el?.querySelectorAll("tbody tr")[n]?.scrollIntoView({ block: "nearest" });
        e.preventDefault();
      } else if (e.key === "Enter" && idx >= 0) onOpen?.(rows[idx]!);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [keys, rows, idx, onSelect, onOpen, rowKey, virtual, rh]);

  const toggle = (id: string, additive: boolean) => onSort?.({ id, dir: sort?.id === id && sort.dir === "asc" ? "desc" : "asc" }, additive);

  return (
    <div ref={ref} className={flush ? `${css.wrap} ${css.flush}` : css.wrap} style={virtual?.height ? { height: virtual.height } : undefined}>
      <table className={`${css.table} ${virtual ? css.virtual : ""} ${muted ? css.muted : ""}`} aria-label={label} style={virtual ? ({ minWidth: minTableWidth(columns), "--vrow": `${rh}px` } as CSSProperties) : undefined}
        aria-rowcount={virtual ? rows.length + 1 : undefined}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              return (
                <th key={c.id} scope="col" className={c.align === "r" ? "num" : undefined} style={{ width: c.width }} title={c.title}
                  aria-sort={c.sortable ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined}>
                  {c.sortable ? (
                    <button type="button" className={css.sortBtn} onClick={(e) => toggle(c.id, e.shiftKey)}>
                      {c.header}{active && <span className={css.arrow} aria-hidden>{sort!.dir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {win && win.padTop > 0 && <tr className={css.spacer} aria-hidden><td colSpan={columns.length} style={{ height: win.padTop }} /></tr>}
          {(win ? rows.slice(win.start, win.end) : rows).map((r, i) => {
            const k = rowKey(r), sel = k === selectedKey;
            return [
              <tr key={k} className={`${css.row} ${sel ? css.selected : ""} ${rowClass?.(r) ?? ""}`} aria-selected={sel} tabIndex={sel ? 0 : -1}
                aria-rowindex={win ? win.start + i + 2 : undefined}
                onClick={() => { onSelect?.(k); onOpen?.(r); }}
                onFocus={() => onSelect?.(k)}>
                {columns.map((c) => <td key={c.id} className={c.align === "r" ? "num" : undefined}>{c.cell(r)}</td>)}
              </tr>,
              sel && renderExpanded && !virtual ? (
                <tr key={`${k}:x`} className={css.expanded}><td colSpan={columns.length}>{renderExpanded(r)}</td></tr>
              ) : null,
            ];
          })}
          {win && win.padBottom > 0 && <tr className={css.spacer} aria-hidden><td colSpan={columns.length} style={{ height: win.padBottom }} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Market cell: truncated question with full text in title + category tag. */
export function MarketCell({ question, category, max = 56 }: { question: string; category: string | null; max?: number }) {
  return (
    <span className={`ui ${css.truncate}`} title={question} style={{ display: "inline-block", maxWidth: `${max}ch` }}>
      {question}{category && <span className={css.tag}>{category}</span>}
    </span>
  );
}

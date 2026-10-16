"use client";
import { useEffect, useRef, type ReactNode } from "react";
import css from "./DataTable.module.css";
import { inInput } from "../hooks/useGlobalKeys";

export type Column<T> = { id: string; header: ReactNode; align: "l" | "r"; sortable?: boolean; width?: string; cell: (row: T) => ReactNode; title?: string };
export type Sort = { id: string; dir: "asc" | "desc" };

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: Sort;
  onSort?: (s: Sort) => void;
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
};

/** The one table. Real <table>, sticky header, aria-sort buttons, j/k/Enter, selection bar. */
export function DataTable<T>({ columns, rows, rowKey, sort, onSort, selectedKey, onSelect, onOpen, renderExpanded, muted, keys = true, label, rowClass }: DataTableProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = selectedKey == null ? -1 : rows.findIndex((r) => rowKey(r) === selectedKey);

  useEffect(() => {
    if (!keys) return;
    const h = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "k") {
        if (!rows.length) return;
        const n = e.key === "j" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
        onSelect?.(rowKey(rows[n]!));
        ref.current?.querySelectorAll("tbody tr")[n]?.scrollIntoView({ block: "nearest" });
        e.preventDefault();
      } else if (e.key === "Enter" && idx >= 0) onOpen?.(rows[idx]!);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [keys, rows, idx, onSelect, onOpen, rowKey]);

  const toggle = (id: string) => onSort?.({ id, dir: sort?.id === id && sort.dir === "asc" ? "desc" : "asc" });

  return (
    <div ref={ref} className={css.wrap}>
      <table className={`${css.table} ${muted ? css.muted : ""}`} aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              return (
                <th key={c.id} scope="col" className={c.align === "r" ? "num" : undefined} style={{ width: c.width }} title={c.title}
                  aria-sort={c.sortable ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined}>
                  {c.sortable ? (
                    <button type="button" className={css.sortBtn} onClick={() => toggle(c.id)}>
                      {c.header}{active ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r), sel = k === selectedKey;
            return [
              <tr key={k} className={`${css.row} ${sel ? css.selected : ""} ${rowClass?.(r) ?? ""}`} aria-selected={sel} tabIndex={sel ? 0 : -1}
                onClick={() => { onSelect?.(k); onOpen?.(r); }}
                onFocus={() => onSelect?.(k)}>
                {columns.map((c) => <td key={c.id} className={c.align === "r" ? "num" : undefined}>{c.cell(r)}</td>)}
              </tr>,
              sel && renderExpanded ? (
                <tr key={`${k}:x`} className={css.expanded}><td colSpan={columns.length}>{renderExpanded(r)}</td></tr>
              ) : null,
            ];
          })}
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

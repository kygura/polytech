"use client";
import { DataTable, MarketCell, type Column } from "./DataTable";
import { NumCell } from "./NumCell";
import { fmt, hm, mmdd } from "./fmt";
import type { PaperBook } from "./PositionsTable";
import css from "./panels.module.css";

export type Fill = PaperBook["fills"][number];
const dash = <span className="muted">{"—"}</span>;

/** Slippage = fill − modeled k; paying more than modeled is bad → --neg. Sign always shown. */
const Slip = ({ c }: { c: number | null }) => (c == null ? dash : <span className={Math.abs(c) < 0.5 ? "muted" : c > 0 ? "neg" : "pos"}>{fmt(c, "cents", true)}</span>);

const COLS: Column<Fill>[] = [
  { id: "ts", header: "ts", align: "r", cell: (f) => `${mmdd(f.ts)} ${hm(f.ts)}` },
  { id: "market", header: "Market", align: "l", cell: (f) => <><MarketCell question={f.question} category={null} max={40} />{f.paper && <span className={css.chip}>PAPER</span>}</> },
  { id: "side", header: "Side", align: "l", cell: (f) => (f.side ? <span className={f.side === "YES" ? "pos" : "neg"}>{f.side}</span> : dash) },
  { id: "price", header: "Price", align: "r", cell: (f) => <NumCell value={f.price} fmt="p" /> },
  { id: "size", header: "Size", align: "r", cell: (f) => <NumCell value={f.size} fmt="int" /> },
  { id: "fee", header: "Fee", align: "r", cell: (f) => f.fee.toFixed(2) },
  { id: "k", header: "k(S) modeled", align: "r", cell: (f) => <NumCell value={f.modeledK} fmt="p" /> },
  { id: "slip", header: "Slip¢", align: "r", cell: (f) => <Slip c={f.slipC} /> },
  { id: "viol", header: "Violations", align: "l", cell: (f) => (f.violations.length ? f.violations.map((v) => <span key={v} className={css.tag}>{v}</span>) : dash) },
];

export function FillsTable({ fills }: { fills: Fill[] }) {
  return fills.length ? <DataTable columns={COLS} rows={fills} rowKey={(f) => `${f.ts}:${f.conditionId}:${f.price}:${f.size}`} keys={false} label="paper fills" /> : <p className={`muted ${css.line}`}>No fills yet.</p>;
}

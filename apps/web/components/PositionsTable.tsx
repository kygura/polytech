"use client";
import Link from "next/link";
import { DataTable, type Column } from "./DataTable";
import { EdgeBadge } from "./EdgeBadge";
import { NumCell } from "./NumCell";
import { Flat, MarketTitle } from "./pageParts";
import { mmdd } from "./fmt";
import type { read } from "../lib/jobs";
import css from "./panels.module.css";

export type PaperBook = Awaited<ReturnType<typeof read.paperBook>>;
export type Position = PaperBook["positions"][number];

const Side = ({ side }: { side: "YES" | "NO" | null }) => (side ? <span className={side === "YES" ? "yes" : "no"}>{side}</span> : <span className="muted">{"—"}</span>);
const row2 = () => "row2";
const dash = <span className="muted">{"—"}</span>;

const cols = (closed: boolean, onClose?: (id: number) => void): Column<Position>[] => [
  { id: "market", header: "Market", align: "l", cell: (p) => <MarketTitle id={p.conditionId} question={p.question} /> },
  { id: "side", header: "Side", align: "l", cell: (p) => <Side side={p.side} /> },
  { id: "size", header: "Size", align: "r", cell: (p) => <NumCell value={p.size} fmt="int" /> },
  { id: "cost", header: "Avg cost (k)", align: "r", cell: (p) => <NumCell value={p.avgCost} fmt="p" /> },
  { id: "mid", header: "Mid now", align: "r", cell: (p) => <NumCell value={p.midNow} fmt="p" /> },
  { id: "unreal", header: "Unreal $", align: "r", cell: (p) => <NumCell value={p.unrealizedUsd} fmt="usd" signed /> },
  { id: "mod", header: "Modeled e¢", align: "r", cell: (p) => <EdgeBadge cents={p.modeledEdgeC} /> },
  { id: "real", header: "Realized e¢", align: "r", cell: (p) => <EdgeBadge cents={p.realizedEdgeC} /> },
  { id: "opened", header: "Opened", align: "r", cell: (p) => mmdd(p.openedAt) },
  ...(closed ? [
    { id: "closed", header: "Closed", align: "r", cell: (p) => (p.closedAt ? mmdd(p.closedAt) : dash) },
    { id: "result", header: "Result", align: "l", cell: (p) => (p.result == null ? dash : <span className={p.result === "YES" ? "yes" : "no"}>{p.result}</span>) },
    { id: "pnl", header: "Realized $", align: "r", cell: (p) => <NumCell value={p.realizedPnl} fmt="usd" signed /> },
  ] satisfies Column<Position>[] : []),
  { id: "thesis", header: "Thesis", align: "l", cell: (p) => <Link href={`/trade/${encodeURIComponent(p.conditionId)}`} onClick={(e) => e.stopPropagation()}>{p.thesisId ? "thesis ↗" : "market ↗"}</Link> },
  ...(onClose ? [{ id: "close", header: "", align: "l", cell: (p) => <button type="button" onClick={(e) => { e.stopPropagation(); onClose(p.id); }} aria-label={`Close paper position ${p.id} at best bid`}>Close</button> } satisfies Column<Position>] : []),
];

export function PositionsTable({ positions, onClose, onOpen, selected, onSelect }: { positions: Position[]; onClose: (id: number) => void; onOpen: (p: Position) => void; selected: string | null; onSelect: (k: string) => void }) {
  const open = positions.filter((p) => p.closedAt == null), closed = positions.filter((p) => p.closedAt != null);
  const key = (p: Position) => String(p.id);
  return (
    <>
      {open.length ? <Flat><DataTable columns={cols(false, onClose)} rows={open} rowKey={key} selectedKey={selected} onSelect={onSelect} onOpen={onOpen} label="open positions" rowClass={row2} /></Flat> : <p className={`muted ${css.line}`}>No open positions.</p>}
      <div className={css.divider}>closed ({closed.length})</div>
      {closed.length ? <Flat><DataTable columns={cols(true)} rows={closed} rowKey={key} onOpen={onOpen} keys={false} label="closed positions" rowClass={row2} /></Flat> : <p className={`muted ${css.line}`}>No closed positions.</p>}
    </>
  );
}

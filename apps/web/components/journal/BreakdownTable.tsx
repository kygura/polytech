"use client";
import { Delta } from "../BrierTable";
import { DataTable, type Column } from "../DataTable";
import { EdgeBadge } from "../EdgeBadge";
import { fmt } from "../fmt";
import { GATE_N, type BreakdownRow } from "./journal";
import j from "./journal.module.css";

const p3 = (v: number | null) => (v == null ? <span className="muted">{"—"}</span> : v.toFixed(3));
const COLS = (label: string): Column<BreakdownRow>[] => [
  { id: "group", header: label, align: "l", cell: (r) => <span className="ui">{r.key}</span> },
  { id: "n", header: "n", align: "r", cell: (r) => r.n },
  { id: "brier", header: "Brier", align: "r", cell: (r) => p3(r.brier) },
  { id: "mkt", header: "Mkt Brier", align: "r", cell: (r) => p3(r.market) },
  { id: "delta", header: "Δ", align: "r", cell: (r) => (r.brier != null && r.market != null ? <Delta ours={r.brier} market={r.market} /> : <span className="muted">{"—"}</span>) },
  { id: "pre", header: "Pre Brier", align: "r", cell: (r) => p3(r.pre) },
  { id: "ll", header: "Log loss", align: "r", cell: (r) => (r.logLoss == null ? <span className="muted">{"—"}</span> : r.logLoss.toFixed(2)) },
  { id: "drift", header: "Drift 7d", align: "r", cell: (r) => <EdgeBadge cents={r.drift7} /> },
  { id: "pnl", header: "P&L", align: "r", cell: (r) => (r.pnl == null ? <span className="muted">{"—"}</span> : <span className={r.pnl > 0 ? "pos" : r.pnl < 0 ? "neg" : "muted"}>{`${r.pnl < 0 ? "−" : r.pnl > 0 ? "+" : ""}$${fmt(Math.abs(r.pnl), "usd")}`}</span>) },
  { id: "hit", header: "Hit %", align: "r", cell: (r) => (r.hit == null ? <span className="muted">{"—"}</span> : `${Math.round(r.hit * 100)}%`) },
  { id: "gate", header: "gate", align: "r", cell: (r) => <>{r.gate}{r.n >= GATE_N && <span className="pos"> {"✓"}</span>}</> },
];

/** Journal breakdown (DESIGN 12.4.4). Groups under min n are muted and sorted last (done in breakdownRows). */
export function BreakdownTable({ rows, label, minN }: { rows: BreakdownRow[]; label: string; minN: number }) {
  return (
    <section className="pane">
      <h2>Breakdown <span className={j.sub}>{"·"} by {label} {"·"} min n {minN}</span></h2>
      <DataTable columns={COLS(label)} rows={rows} rowKey={(r) => r.key} keys={false} label={`journal by ${label}`} rowClass={(r) => (r.low ? j.low : undefined)} />
    </section>
  );
}

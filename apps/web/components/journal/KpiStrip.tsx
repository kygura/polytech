import type { JournalSummary } from "@pm/core";
import { Delta } from "../BrierTable";
import { EdgeBadge } from "../EdgeBadge";
import { fmt } from "../fmt";
import { GATE_N, type DriftHist } from "./journal";
import j from "./journal.module.css";

const p3 = (v: number | null) => (v == null ? "—" : v.toFixed(3));

/** Six KPI cells (DESIGN 12.4.1); a muted seventh while under the refit gate. */
export function KpiStrip({ s, hist }: { s: JournalSummary; hist: DriftHist }) {
  const pnl = s.paperPnl;
  return (
    <dl className={j.kpis} aria-label="journal KPIs">
      <div className={j.kpi}><dt>Resolved</dt><dd>{s.resolved}</dd></div>
      <div className={j.kpi}><dt>Brier model · mkt · Δ</dt>
        <dd>{p3(s.brierModel)} <span className={j.sub}>·</span> {p3(s.brierMarket)} <span className={j.sub}>·</span> {s.brierModel != null && s.brierMarket != null ? <Delta ours={s.brierModel} market={s.brierMarket} /> : "—"}</dd></div>
      <div className={j.kpi}><dt>Log loss</dt><dd>{s.logLoss == null ? "—" : s.logLoss.toFixed(2)}</dd></div>
      <div className={j.kpi}><dt>Pre → final</dt><dd>{p3(s.brierPre)} <span className={j.sub}>{"→"}</span> {p3(s.brierModel)}</dd></div>
      <div className={j.kpi}><dt>Drift 24h · 7d</dt><dd><EdgeBadge cents={hist.mean24} /> <EdgeBadge cents={hist.mean7} /></dd></div>
      <div className={j.kpi}><dt>Paper P&amp;L</dt><dd className={pnl > 0 ? "pos" : pnl < 0 ? "neg" : "muted"}>{pnl === 0 ? "$0" : `${pnl < 0 ? "−" : "+"}$${fmt(Math.abs(pnl), "usd")}`}</dd></div>
      {s.resolved < GATE_N && <div className={`${j.kpi} ${j.kpiNote}`}><dt>Refit gate</dt><dd>{s.resolved}/{GATE_N} resolved {"·"} refit unlocks at {GATE_N}</dd></div>}
    </dl>
  );
}

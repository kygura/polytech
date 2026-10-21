import type { JournalSummary } from "@pm/core";
import { Delta } from "../BrierTable";
import { EdgeBadge } from "../EdgeBadge";
import { fmt } from "../fmt";
import { Kpis } from "../pageParts";
import { GATE_N, type DriftHist } from "./journal";
import j from "./journal.module.css";

const p3 = (v: number | null) => (v == null ? "—" : v.toFixed(3));

/** Six KPI cells (DESIGN 12.4.1); a muted seventh while under the refit gate. */
export function KpiStrip({ s, hist }: { s: JournalSummary; hist: DriftHist }) {
  const pnl = s.paperPnl;
  return (
    <Kpis label="journal KPIs" items={[
      { label: "Resolved", value: s.resolved },
      { label: "Brier model · mkt · Δ", value: <>{p3(s.brierModel)} <span className={j.sub}>·</span> {p3(s.brierMarket)} <span className={j.sub}>·</span> {s.brierModel != null && s.brierMarket != null ? <Delta ours={s.brierModel} market={s.brierMarket} /> : "—"}</> },
      { label: "Log loss", value: s.logLoss == null ? "—" : s.logLoss.toFixed(2) },
      { label: "Pre → final", value: <>{p3(s.brierPre)} <span className={j.sub}>{"→"}</span> {p3(s.brierModel)}</> },
      { label: "Drift 24h · 7d", value: <><EdgeBadge cents={hist.mean24} /> <EdgeBadge cents={hist.mean7} /></> },
      { label: "Paper P&L", value: <span className={pnl > 0 ? "up" : pnl < 0 ? "down" : "muted"}>{pnl === 0 ? "$0" : `${pnl < 0 ? "−" : "+"}$${fmt(Math.abs(pnl), "usd")}`}</span> },
      ...(s.resolved < GATE_N ? [{ label: "Refit gate", value: `${s.resolved}/${GATE_N} resolved · refit unlocks at ${GATE_N}`, note: true }] : []),
    ]} />
  );
}

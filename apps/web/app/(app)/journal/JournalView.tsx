"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { Delta } from "../../../components/BrierTable";
import { EmptyState } from "../../../components/EmptyState";
import { ReliabilityChart } from "../../../components/ReliabilityChart";
import { BrierCompareChart } from "../../../components/journal/BrierCompareChart";
import { BreakdownTable } from "../../../components/journal/BreakdownTable";
import { DriftHistogram } from "../../../components/journal/DriftHistogram";
import { KpiStrip } from "../../../components/journal/KpiStrip";
import { PnlCurve } from "../../../components/journal/PnlCurve";
import { GATE_N, GROUPS, ROLLING, breakdownRows, driftHistogram, rollingBrier, type GroupBy } from "../../../components/journal/journal";
import j from "../../../components/journal/journal.module.css";
import type { terminal } from "../../../lib/jobs";
import css from "../../../components/panels.module.css";
import ui from "../../../components/ui.module.css";

export type JournalData = Awaited<ReturnType<typeof terminal.journalView>>;
export type Filters = { category: string; model: string; sinceDays: string; groupBy: GroupBy; minN: number };
const WINDOWS: [string, string][] = [["30", "30d"], ["90", "90d"], ["", "all"]];

const Mark = ({ n }: { n: number }) => (n < GATE_N ? <span className={j.mark}>n={n} {"·"} low confidence</span> : null);

export function JournalView({ data, filters, categories, models, extremize }: { data: JournalData; filters: Filters; categories: string[]; models: string[]; extremize: number }) {
  const router = useRouter();
  const go = (patch: Partial<Filters>) => {
    const f = { ...filters, ...patch };
    const q = new URLSearchParams(Object.entries({ category: f.category, model: f.model, sinceDays: f.sinceDays, groupBy: f.groupBy === "category" ? "" : f.groupBy, minN: f.minN === 5 ? "" : String(f.minN) }).filter(([, v]) => v));
    router.push(`/journal${q.size ? `?${q}` : ""}`);
  };
  const { summary: s, rows, bins, suggested } = data;
  const rolling = useMemo(() => rollingBrier(rows), [rows]);
  const hist = useMemo(() => driftHistogram(rows.filter((r) => r.result)), [rows]);
  const groups = useMemo(() => breakdownRows(rows, filters.groupBy, filters.minN), [rows, filters.groupBy, filters.minN]);
  const groupLabel = GROUPS.find(([g]) => g === filters.groupBy)![1];

  return (
    <>
      <div className={css.controls}>
        <label>category
          <select value={filters.category} onChange={(e) => go({ category: e.target.value })}><option value="">all</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <label>model
          <select value={filters.model} onChange={(e) => go({ model: e.target.value })}><option value="">all</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <label>window
          <select value={filters.sinceDays} onChange={(e) => go({ sinceDays: e.target.value })}>{WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>group by
          <select value={filters.groupBy} onChange={(e) => go({ groupBy: e.target.value as GroupBy })}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>min n
          <input type="number" min={0} max={999} step={1} defaultValue={filters.minN} key={filters.minN} style={{ width: "5ch" }}
            onBlur={(e) => { const v = Math.max(0, Math.floor(e.target.valueAsNumber)); if (Number.isFinite(v) && v !== filters.minN) go({ minN: v }); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        </label>
      </div>
      {s.resolved === 0 && <EmptyState text="No resolved theses yet. Edge is measured forward; rows appear as markets resolve." />}
      <KpiStrip s={s} hist={hist} />
      <div className={css.half} style={{ marginBottom: "var(--sp-3)" }}>
        <section className="pane">
          <h2>Reliability</h2>
          <div className={`body ${j.wm}`}>
            <Mark n={s.resolved} />
            <ReliabilityChart bins={bins} />
            {s.brierModel != null && s.brierMarket != null && <p className={css.line} style={{ margin: 0 }}>
              Brier {s.brierModel.toFixed(3)} {"·"} log loss {s.logLoss == null ? "—" : s.logLoss.toFixed(2)} {"·"} n {s.resolved} {"·"} market Brier {s.brierMarket.toFixed(3)} {"·"} Δ <Delta ours={s.brierModel} market={s.brierMarket} />
            </p>}
          </div>
        </section>
        <section className="pane">
          <h2>Paper P&amp;L</h2>
          <div className={`body ${j.wm}`}><Mark n={s.resolved} /><PnlCurve series={s.pnlSeries} /></div>
        </section>
      </div>
      <div className={css.half} style={{ marginBottom: "var(--sp-3)" }}>
        <section className="pane">
          <h2>Brier {"·"} model vs market vs pre-reveal <span className={j.legend}>{"—"} model {" ╌ "} market {" ⋯ "} pre-reveal</span></h2>
          <div className={`body ${j.wm}`}>
            <Mark n={s.resolved} />
            {rolling.length ? <BrierCompareChart points={rolling} /> : <EmptyState text={`Rolling Brier needs ${ROLLING} resolved theses (n=${s.resolved}).`} />}
          </div>
        </section>
        <section className="pane">
          <h2>Drift toward p̂ <span className={j.legend}>24h / 7d, ¢</span></h2>
          <div className={`body ${j.wm}`}><Mark n={s.resolved} /><DriftHistogram hist={hist} /></div>
        </section>
      </div>
      <BreakdownTable rows={groups} label={groupLabel} minN={filters.minN} />
      {suggested && (
        <p className={`${ui.bar} ${ui.barWarn}`} style={{ marginTop: "var(--sp-3)" }} role="status">
          <span>Refit suggested from n={suggested.n}: extremize {extremize.toFixed(2)} {"→"} {suggested.extremize.toFixed(2)} {"·"} <Link href="/settings#calibration">apply in Settings {"→"}</Link></span>
        </p>
      )}
    </>
  );
}

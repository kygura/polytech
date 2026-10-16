"use client";
import { useRouter } from "next/navigation";
import { BrierTable, Delta } from "../../../components/BrierTable";
import { EmptyState } from "../../../components/EmptyState";
import { ReliabilityChart } from "../../../components/ReliabilityChart";
import type { read } from "../../../lib/jobs";
import css from "../../../components/panels.module.css";

export type Calibration = Awaited<ReturnType<typeof read.calibration>>;
export type Filters = { category: string; model: string; sinceDays: string };
const WINDOWS: [string, string][] = [["30", "30d"], ["90", "90d"], ["", "all"]];

export function CalibrationView({ data, filters, categories, models }: { data: Calibration; filters: Filters; categories: string[]; models: string[] }) {
  const router = useRouter();
  const go = (patch: Partial<Filters>) => {
    const q = new URLSearchParams(Object.entries({ ...filters, ...patch }).filter(([, v]) => v));
    router.push(`/calibration${q.size ? `?${q}` : ""}`);
  };
  const o = data.overall;
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
      </div>
      {data.n === 0 ? <EmptyState text="No resolved forecasts yet. Calibration runs nightly." /> : (
        <div className={css.half}>
          <section className="pane">
            <h2>Reliability</h2>
            <div className="body">
              <ReliabilityChart bins={data.bins} />
              {o && <p className={css.line} style={{ margin: 0 }}>
                Brier {o.brier.toFixed(3)} {"·"} log loss {o.logLoss.toFixed(2)} {"·"} n {o.n} {"·"} market Brier {o.marketBrier.toFixed(3)} {"·"} Δ <Delta ours={o.brier} market={o.marketBrier} />
              </p>}
            </div>
          </section>
          <div className={css.stack}><BrierTable byCategory={data.byCategory} byModel={data.byModel} /></div>
        </div>
      )}
    </>
  );
}

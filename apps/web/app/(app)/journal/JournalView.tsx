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
import type { read, terminal } from "../../../lib/jobs";
import pg from "../../../components/page.module.css";
import { Panel } from "../../../components/ui";
import ui from "../../../components/ui.module.css";

export type JournalData = Awaited<ReturnType<typeof terminal.journalView>>;
export type Fade = Awaited<ReturnType<typeof read.calibration>>["fade"];
export type Filters = { category: string; model: string; sinceDays: string; groupBy: GroupBy; minN: number };
const WINDOWS: [string, string][] = [["30", "30d"], ["90", "90d"], ["", "all"]];

const Mark = ({ n }: { n: number }) => (n < GATE_N ? <span className={j.mark}>n={n} {"·"} low confidence</span> : null);

export function JournalView({ data, filters, categories, models, extremize, fade }: { data: JournalData; filters: Filters; categories: string[]; models: string[]; extremize: number; fade: Fade }) {
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

  const legend = (
    <span className={j.legend}><span className={j.lgModel}>{"—"}</span> model <span className={j.lgMarket}>{" ╌ "}</span> market <span className={j.lgPre}>{" ⋯ "}</span> pre-reveal</span>
  );
  return (
    <div className={pg.stack}>
      <div className="page-h">
        <h1>Journal</h1>
        <div className="r">
          <label className={j.ctl}>category
            <select value={filters.category} onChange={(e) => go({ category: e.target.value })}><option value="">all</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          </label>
          <label className={j.ctl}>model
            <select value={filters.model} onChange={(e) => go({ model: e.target.value })}><option value="">all</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </label>
          <label className={j.ctl}>window
            <select value={filters.sinceDays} onChange={(e) => go({ sinceDays: e.target.value })}>{WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className={j.ctl}>group by
            <select value={filters.groupBy} onChange={(e) => go({ groupBy: e.target.value as GroupBy })}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className={j.ctl}>min n
            <input type="number" min={0} max={999} step={1} defaultValue={filters.minN} key={filters.minN} style={{ width: "6ch" }}
              onBlur={(e) => { const v = Math.max(0, Math.floor(e.target.valueAsNumber)); if (Number.isFinite(v) && v !== filters.minN) go({ minN: v }); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          </label>
        </div>
      </div>
      <Panel label="Summary">
        {s.resolved === 0 && <EmptyState text="No resolved theses yet. Edge is measured forward; rows appear as markets resolve." />}
        <KpiStrip s={s} hist={hist} />
      </Panel>
      <div className={j.half}>
        <Panel title="Reliability">
          <div className={j.wm}>
            <Mark n={s.resolved} />
            <ReliabilityChart bins={bins} />
            {s.brierModel != null && s.brierMarket != null && <p className={pg.line} style={{ padding: "var(--sp-2) 0 0" }}>
              Brier <span className="n">{s.brierModel.toFixed(3)}</span> {"·"} log loss <span className="n">{s.logLoss == null ? "—" : s.logLoss.toFixed(2)}</span> {"·"} n <span className="n">{s.resolved}</span> {"·"} market Brier <span className="n">{s.brierMarket.toFixed(3)}</span> {"·"} Δ <Delta ours={s.brierModel} market={s.brierMarket} />
            </p>}
          </div>
        </Panel>
        <Panel title="Paper P&amp;L">
          <div className={j.wm}><Mark n={s.resolved} /><PnlCurve series={s.pnlSeries} /></div>
        </Panel>
      </div>
      <div className={j.half}>
        <Panel title={<>Brier {"·"} model vs market vs pre-reveal</>} right={legend}>
          <div className={j.wm}>
            <Mark n={s.resolved} />
            {rolling.length ? <BrierCompareChart points={rolling} /> : <p className={pg.hint}>{`Rolling Brier needs ${ROLLING} resolved theses (n=${s.resolved}).`}</p>}
          </div>
        </Panel>
        <Panel title="Drift toward p̂" right={<span className={j.legend}>24h / 7d, ¢</span>}>
          <div className={j.wm}><Mark n={s.resolved} /><DriftHistogram hist={hist} /></div>
        </Panel>
      </div>
      <Panel title="Longshot fades" right={<span className={j.legend}>all categories, unfiltered</span>}>
        <FadeLine f={fade} />
      </Panel>
      <BreakdownTable rows={groups} label={groupLabel} minN={filters.minN} />
      {suggested && (
        <p className={`${ui.bar} ${ui.barWarn}`} role="status">
          <span>Refit suggested from n={suggested.n}: extremize {extremize.toFixed(2)} {"→"} {suggested.extremize.toFixed(2)} {"·"} <Link href="/settings#calibration">apply in Settings {"→"}</Link></span>
        </p>
      )}
    </div>
  );
}

const pc = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1).replace(/\.0$/, "")}%`);
/** Theses that bet against a 3-20% longshot: what the market priced it at, what we said, how often it happened, and the confidence new fades get. */
function FadeLine({ f }: { f: Fade }) {
  if (!f.n) return <p className={pg.hint}>No resolved fades yet. A fade is a thesis that puts a 3–20% longshot below its price; until 30 resolve and beat the market, they size at confidence 0.4.</p>;
  return (
    <p className={pg.line}>
      n <span className="n">{f.gate}</span> {"·"} market said <span className="n">{pc(f.marketP)}</span> {"·"} we said <span className="n">{pc(f.ourP)}</span> {"·"} happened <span className="n">{pc(f.hitRate)}</span>
      {" · "}Brier <span className="n">{f.brier == null ? "—" : f.brier.toFixed(3)}</span> vs market <span className="n">{f.marketBrier == null ? "—" : f.marketBrier.toFixed(3)}</span>
      {" · "}skill <span className="n">{f.skill == null ? "—" : f.skill.toFixed(2)}</span> {"·"} fade confidence <span className="n">{f.c.toFixed(2)}</span>
      {f.n < 30 && <span className={j.mark}> unlocks at 30</span>}
    </p>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { inInput } from "../hooks/useGlobalKeys";
import { usePoll } from "../hooks/usePoll";
import { RANGES, type HistoryResult, type Range } from "../lib/history";
import { OutcomeChart, type Show } from "./chart/OutcomeChart";
import { Segmented } from "./Segmented";
import css from "./detail.module.css";

type Pt = { ts: number; mid: number | null };
type Marker = { ts: number; pHat: number; side: "YES" | "NO" };

const OPTIONS = RANGES.map((r) => ({ value: r, label: r.toUpperCase() }));
const SHOW = [{ value: "both", label: "Both" }, { value: "YES", label: "Yes" }, { value: "NO", label: "No" }] as const;
const EMPTY: Record<Range, string> = { "1d": "No points in the last day", "1w": "No points in the last week", "1m": "No points in the last month", all: "No price history yet" };

/** `[` / `]` step the range, clamped at both ends. */
export const stepRange = (r: Range, d: 1 | -1): Range => RANGES[Math.min(RANGES.length - 1, Math.max(0, RANGES.indexOf(r) + d))]!;

/** DESIGN 12.6.2: `Price history` pane with a 1D / 1W / 1M / ALL control. Range lives in the URL (`?range=`); the slice comes from /api/markets/[id]/history. */
export function PriceHistoryPane({ conditionId, initialRange, markers, fallback }: { conditionId: string; initialRange: Range; markers: Marker[]; fallback: Pt[] }) {
  const [range, setRange] = useState<Range>(initialRange);
  const [show, setShow] = useState<Show>("both");
  const h = usePoll<HistoryResult>(`/api/markets/${encodeURIComponent(conditionId)}/history?range=${range}`, 60_000);

  const cur = useRef(range);
  cur.current = range;
  const pick = (r: Range) => {
    setRange(r);
    try {
      const u = new URL(location.href);
      u.searchParams.set("range", r);
      history.replaceState(history.state, "", u);
    } catch { /* URL sync is best effort */ }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inInput(e) || (e.key !== "[" && e.key !== "]")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      const n = stepRange(cur.current, e.key === "]" ? 1 : -1);
      if (n !== cur.current) pick(n);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const series = h.data?.points ?? (h.error ? fallback : null); // fetch failed: show our own snapshots rather than nothing
  return (
    <section className="pane" aria-busy={h.loading}>
      <h2 className={css.titleRow}>
        <span>Price history</span>
        <span style={{ display: "inline-flex", gap: "var(--sp-2)" }}>
          <Segmented label="Outcomes shown" options={SHOW} value={show} onChange={setShow} />
          <Segmented label="Price history range" options={OPTIONS} value={range} onChange={pick} />
        </span>
      </h2>
      <div className="body">
        {series == null ? <div className="muted" style={{ height: 180 }}>Loading…</div>
          : <OutcomeChart height={260} show={show} empty={EMPTY[range]}
              points={series.flatMap((p) => (p.mid == null ? [] : [{ ts: p.ts, p: p.mid }]))}
              markers={markers.map((m) => ({ ts: m.ts, p: m.pHat, outcome: m.side, label: `p̂ ${(m.pHat * 100).toFixed(0)}¢ ${m.side}` }))} />}
        {h.data?.source === "snapshots" && <div className="muted" role="note">Polymarket history unavailable; showing our own snapshots.</div>}
        {h.error && h.data == null && <div className="muted" role="note">History request failed ({h.error}); showing the latest snapshots.</div>}
      </div>
    </section>
  );
}

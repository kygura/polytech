import { EdgeBadge } from "../EdgeBadge";
import { DataTable, MarketCell, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { NumCell } from "../NumCell";
import { Skeleton } from "../Skeleton";
import { hm, mmdd } from "../fmt";
import cx from "../../app/(app)/research/research.module.css";

export type Match = { conditionId: string; question: string; vol24h: number | null; spread: number | null; endDate: string | null; edgeC: number | null };
export type PreviewState = { state: "idle" | "loading" | "error"; matches: Match[] | null; at: number | null; error?: string; limit: number; hint: string };

const cols = (now: number): Column<Match>[] => [
  { id: "q", header: "Market", align: "l", cell: (m) => <a href={`/markets/${m.conditionId}`} target="_blank" rel="noreferrer"><MarketCell question={m.question} category={null} /></a> },
  { id: "vol", header: "Vol 24h", align: "r", cell: (m) => <NumCell value={m.vol24h} fmt="usd" /> },
  { id: "spr", header: "Spread ¢", align: "r", cell: (m) => <NumCell value={m.spread == null ? null : m.spread * 100} fmt="cents" /> },
  { id: "end", header: "Ends", align: "r", cell: (m) => m.endDate ? <span>{mmdd(Date.parse(m.endDate))} <span className="muted">{Math.max(0, Math.round((Date.parse(m.endDate) - now) / 86_400_000))}d</span></span> : <span className="muted">{"—"}</span> },
  { id: "edge", header: "Edge¢", align: "r", cell: (m) => <EdgeBadge cents={m.edgeC} /> },
];

/** Preview of the draft filter. Own table with keys off so j/k stays on the profile list. */
export function PreviewPane({ p, onPreview }: { p: PreviewState; onPreview: () => void }) {
  const busy = p.state === "loading";
  return (
    <section className="pane" aria-label="preview">
      <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Preview</span>
        <button type="button" onClick={onPreview} disabled={busy}>{busy ? "Previewing…" : "Preview matches"}<span className={cx.hint}>p</span></button>
      </h2>
      {p.matches && p.at != null && <div className={`${cx.meta} muted`}>{p.matches.length} of {p.limit} limit · evaluated {hm(p.at)}</div>}
      {p.state === "error" && <ErrorBar message={p.error ?? "Preview failed"} onRetry={onPreview} />}
      {busy && <Skeleton rows={5} />}
      {!busy && p.matches && (p.matches.length
        ? <DataTable columns={cols(Date.now())} rows={p.matches} rowKey={(m) => m.conditionId} keys={false} label="preview matches" />
        : <EmptyState text={`No active markets match this filter.${p.hint ? ` ${p.hint}` : ""}`} />)}
    </section>
  );
}

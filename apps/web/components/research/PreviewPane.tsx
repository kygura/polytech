import { EdgeBadge } from "../EdgeBadge";
import { DataTable, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { NumCell } from "../NumCell";
import { Skeleton } from "../Skeleton";
import { Flat, MarketTitle } from "../pageParts";
import { Button, Panel } from "../ui";
import { hm, mmdd } from "../fmt";
import cx from "../../app/(app)/research/research.module.css";

export type Match = { conditionId: string; question: string; vol24h: number | null; spread: number | null; endDate: string | null; edgeC: number | null };
export type PreviewState = { state: "idle" | "loading" | "error"; matches: Match[] | null; at: number | null; error?: string; limit: number; hint: string };

const row2 = () => "row2";
const cols = (now: number): Column<Match>[] => [
  { id: "q", header: "Market", align: "l", cell: (m) => <MarketTitle id={m.conditionId} question={m.question} newTab /> },
  { id: "vol", header: "Vol 24h", align: "r", cell: (m) => <NumCell value={m.vol24h} fmt="usd" /> },
  { id: "spr", header: "Spread ¢", align: "r", cell: (m) => <NumCell value={m.spread == null ? null : m.spread * 100} fmt="cents" /> },
  { id: "end", header: "Ends", align: "r", cell: (m) => m.endDate ? <span>{mmdd(Date.parse(m.endDate))} <span className="muted">{Math.max(0, Math.round((Date.parse(m.endDate) - now) / 86_400_000))}d</span></span> : <span className="muted">{"—"}</span> },
  { id: "edge", header: "Edge¢", align: "r", cell: (m) => <EdgeBadge cents={m.edgeC} /> },
];

/** Preview of the draft filter. Own table with keys off so j/k stays on the profile list; market links open in a new tab so the draft survives. */
export function PreviewPane({ p, onPreview }: { p: PreviewState; onPreview: () => void }) {
  const busy = p.state === "loading";
  return (
    <Panel title="Preview" label="preview" right={<Button size="sm" onClick={onPreview} disabled={busy}>{busy ? "Previewing…" : <>Preview matches <kbd>p</kbd></>}</Button>}>
      {p.matches && p.at != null && <div className={`${cx.meta} muted`}>{p.matches.length} of {p.limit} limit · evaluated <span className="n">{hm(p.at)}</span></div>}
      {p.state === "error" && <ErrorBar message={p.error ?? "Preview failed"} onRetry={onPreview} />}
      {busy && <Skeleton rows={5} />}
      {!busy && p.matches && (p.matches.length
        ? <Flat><DataTable columns={cols(Date.now())} rows={p.matches} rowKey={(m) => m.conditionId} keys={false} label="preview matches" rowClass={row2} /></Flat>
        : <EmptyState text={`No active markets match this filter.${p.hint ? ` ${p.hint}` : ""}`} />)}
      {!busy && !p.matches && p.state === "idle" && <EmptyState text="Preview shows which markets the filter picks right now." />}
    </Panel>
  );
}

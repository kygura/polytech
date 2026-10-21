import { fmt } from "./fmt";
import { Kpis, Money } from "./pageParts";

export type PnlSummary = { open: number; closed: number; paperPnlUsd: number; modeledEdgeUsd: number; realizedEdgeUsd: number; capture: number | null };

export function PnlStrip({ summary: s }: { summary: PnlSummary }) {
  return (
    <Kpis label="paper P&L" items={[
      { label: "open", value: s.open },
      { label: "closed", value: s.closed },
      { label: "paper P&L", value: <Money value={s.paperPnlUsd} /> },
      { label: "modeled edge", value: <Money value={s.modeledEdgeUsd} /> },
      { label: "realized edge", value: <Money value={s.realizedEdgeUsd} /> },
      { label: "capture", value: s.capture == null ? <span className="muted">{"—"}</span> : fmt(s.capture, "pct") },
    ]} />
  );
}

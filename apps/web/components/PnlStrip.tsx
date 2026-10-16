import { NumCell } from "./NumCell";
import { fmt } from "./fmt";
import css from "./panels.module.css";

export type PnlSummary = { open: number; closed: number; paperPnlUsd: number; modeledEdgeUsd: number; realizedEdgeUsd: number; capture: number | null };

export function PnlStrip({ summary: s }: { summary: PnlSummary }) {
  return (
    <div className={css.strip} aria-label="paper P&L">
      <span className={css.stripItem}><span className="muted ui">open</span> {s.open}</span>
      <span className={css.stripItem}><span className="muted ui">closed</span> {s.closed}</span>
      <span className={css.stripItem}><span className="muted ui">paper P&L</span> $<NumCell value={s.paperPnlUsd} fmt="usd" signed /></span>
      <span className={css.stripItem}><span className="muted ui">modeled edge</span> $<NumCell value={s.modeledEdgeUsd} fmt="usd" signed /></span>
      <span className={css.stripItem}><span className="muted ui">realized edge</span> $<NumCell value={s.realizedEdgeUsd} fmt="usd" signed /></span>
      <span className={css.stripItem}><span className="muted ui">capture</span> {s.capture == null ? <span className="muted">{"—"}</span> : fmt(s.capture, "pct")}</span>
    </div>
  );
}

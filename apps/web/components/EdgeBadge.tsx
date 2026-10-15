import { fmt } from "./fmt";
import css from "./ui.module.css";

/** Signed cents; sign + color, never color alone. |e| < 0.5 is muted. */
export function EdgeBadge({ cents }: { cents: number | null }) {
  if (cents == null) return <span className="muted">{"—"}</span>;
  const cls = Math.abs(cents) < 0.5 ? "muted" : cents > 0 ? "pos" : "neg";
  return <span className={`${css.edge} ${cls}`}>{fmt(cents, "cents", true)}</span>;
}

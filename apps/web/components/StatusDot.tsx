import css from "./ui.module.css";

export type DotStatus = "queued" | "running" | "done" | "failed" | "judging";
const COLOR: Record<DotStatus, string> = { queued: "var(--muted)", running: "var(--accent)", judging: "var(--accent)", done: "var(--pos)", failed: "var(--neg)" };

/** Dot + text. `label={false}` = dot only (PodTable agents cell); status then lives in title/aria-label. */
export function StatusDot({ status, label }: { status: DotStatus; label?: string | false }) {
  const dot = <span className={css.dot} style={{ color: COLOR[status] }} aria-hidden />;
  if (label === false) return <span className={css.status} role="img" aria-label={status} title={status}>{dot}</span>;
  return <span className={css.status}>{dot} {label ?? status}</span>;
}

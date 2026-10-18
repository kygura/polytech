import css from "./terminal.module.css";

/** 5 skeleton rows: a pane's loading state (DESIGN 11.7). */
export function PaneSkeleton({ label = "Loading…" }: { label?: string }) {
  return <div className={css.skBox} role="status" aria-label={label}>{[70, 55, 80, 60, 75].map((w) => <div key={w} className={css.sk} style={{ width: `${w}%` }} />)}</div>;
}

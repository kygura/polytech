import css from "./progress.module.css";

/** Determinate bar (0..100): 6px `--surface-2` track, fill `--focus` while live, `--up` done, `--down` failed, `--muted` stopped. Text label lives beside it, never only the colour. */
export function Progress({ value, tone = "live", label }: { value: number; tone?: "live" | "up" | "down" | "muted"; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span className={css.track} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span className={`${css.fill} ${css[tone]}`} style={{ width: `${v}%` }} />
    </span>
  );
}

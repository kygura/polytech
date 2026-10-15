import css from "./ui.module.css";

export function MeterBar({ value, max, warnAt = 0.8 }: { value: number; max: number; warnAt?: number }) {
  const r = max > 0 ? Math.min(1, value / max) : 0;
  const color = r >= 1 ? "var(--neg)" : r >= warnAt ? "var(--warn)" : "var(--accent)";
  return (
    <span className={css.meter} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${r * 100}%`, background: color }} />
    </span>
  );
}

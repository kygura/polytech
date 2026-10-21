import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import css from "./ui.module.css";

/** Labelled input (DESIGN 13.2): optional unit suffix, right slot on the label row (keys, balance), error and hint lines. `lg` = ticket size. */
export function Input({ label, right, unit, error, hint, lg, numeric, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string; right?: ReactNode; unit?: string; error?: string; hint?: string; lg?: boolean; numeric?: boolean }) {
  const auto = useId(), fid = id ?? auto;
  const cls = [css.inp, lg && css.lg, numeric && css.numeric, error && css.err].filter(Boolean).join(" ");
  return (
    <div className={css.field}>
      {(label || right) && <label htmlFor={fid} className={css.label}><span>{label}</span>{right}</label>}
      <span className={cls}>
        <input id={fid} aria-invalid={error ? true : undefined} aria-describedby={error ? `${fid}-e` : hint ? `${fid}-h` : undefined} {...rest} />
        {unit && <span className={css.unit}>{unit}</span>}
      </span>
      {error ? <span id={`${fid}-e`} className={css.ferr} role="alert">{error}</span> : hint ? <span id={`${fid}-h`} className={css.fhint}>{hint}</span> : null}
    </div>
  );
}

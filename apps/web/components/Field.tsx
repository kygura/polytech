import { useId, type ReactNode } from "react";
import css from "./ui.module.css";

/** Two grid cells (label, input+unit) plus an optional error line. Use inside FormGroup. */
export function Field({ label, unit, error, htmlFor, children }: { label: string; unit?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  const id = useId();
  return (
    <>
      <label htmlFor={htmlFor ?? id}>{label}</label>
      <span className={css.fieldInput}>{children}{unit && <span className={css.unit}>{unit}</span>}</span>
      {error && <span className={css.err} role="alert">{error}</span>}
    </>
  );
}

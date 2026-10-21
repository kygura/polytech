import type { ButtonHTMLAttributes } from "react";
import css from "./ui.module.css";

/** Filter pill (DESIGN 13.2): `pressed` selects it; `onRemove` shows a trailing ×. */
export function Chip({ pressed, onRemove, onClick, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean; onRemove?: () => void }) {
  return (
    <button type="button" className={className ? `${css.chip} ${className}` : css.chip} aria-pressed={pressed} onClick={onRemove ?? onClick} {...rest}>
      {children}{onRemove && <span aria-hidden>{"×"}</span>}
    </button>
  );
}

/** Boxed letter: S structural, C contrarian (DESIGN 12.2). `reason` goes in the tooltip. */
export function Badge({ kind, reason }: { kind: "s" | "c"; reason?: string }) {
  return <span className={`${css.badge} ${css[kind]}`} title={reason} aria-label={reason ?? (kind === "s" ? "structural" : "contrarian")}>{kind.toUpperCase()}</span>;
}

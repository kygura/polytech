import type { ElementType, ReactNode } from "react";
import css from "./ui.module.css";

/** Bordered surface with an optional header (title left, `right` slot) and a scrolling body (DESIGN 13.2). */
export function Panel({ title, right, pad, as: As = "section", className, label, children }: { title?: ReactNode; right?: ReactNode; pad?: boolean; as?: ElementType; className?: string; label?: string; children: ReactNode }) {
  return (
    <As className={className ? `${css.panel} ${className}` : css.panel} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      {(title != null || right != null) && <h2 className={css.panelH}>{title}{right != null && <span className={css.panelR}>{right}</span>}</h2>}
      <div className={pad ? `${css.panelB} ${css.pad}` : css.panelB}>{children}</div>
    </As>
  );
}

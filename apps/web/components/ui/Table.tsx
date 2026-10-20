import type { ReactNode } from "react";
import css from "./ui.module.css";

/** Scroll container for a table inside a Panel (DESIGN 13.2): the wrapper scrolls, the page never does. Row/cell styles come from the global table rules; `className="row2"` on a `<tr>` gives two-line rows. */
export function Table({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <div className={className ? `${css.tblWrap} ${className}` : css.tblWrap}><table aria-label={label}>{children}</table></div>;
}

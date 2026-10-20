import type { ReactNode } from "react";
import css from "./ui.module.css";

export function FormGroup({ id, title, dirty, onSave, saveLabel, children }: { id?: string; title: string; dirty?: boolean; onSave?: () => void; saveLabel?: string; children: ReactNode }) {
  return (
    <section id={id} className={`pane ${css.group}`}>
      <h2 className={css.groupHead}>
        <span>{title}{dirty && <span className="warn" title="unsaved changes"> {"•"}</span>}</span>
        {onSave && <button type="button" onClick={onSave} disabled={!dirty}>{saveLabel ?? `Save ${title.toLowerCase()}`}</button>}
      </h2>
      <div className={css.grid2}>{children}</div>
    </section>
  );
}

import type { ReactNode } from "react";
import { Button, Panel } from "./ui";
import css from "./ui.module.css";

/** One Panel per group (DESIGN 13.6): title left, optional `Save …` in the header's right slot (secondary, primary while dirty), label | field grid in the body. */
export function FormGroup({ id, title, dirty, onSave, saveLabel, children }: { id?: string; title: string; dirty?: boolean; onSave?: () => void; saveLabel?: string; children: ReactNode }) {
  return (
    <div id={id}>
      <Panel label={title}
        title={<span>{title}{dirty && <span className="warn" title="unsaved changes"> {"•"}</span>}</span>}
        right={onSave && <Button size="sm" variant={dirty ? "primary" : "secondary"} onClick={onSave} disabled={!dirty}>{saveLabel ?? `Save ${title.toLowerCase()}`}</Button>}>
        <div className={css.grid2}>{children}</div>
      </Panel>
    </div>
  );
}

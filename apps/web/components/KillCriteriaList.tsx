import { Panel } from "./ui";
import css from "./detail.module.css";

/** `fired` marks indices the server flagged; none are flagged in this build. */
export function KillCriteriaList({ items, fired = [] }: { items: string[]; fired?: number[] }) {
  return (
    <Panel title="Kill criteria">
      {items.length ? (
        <ul className={`ui ${css.list}`}>
          {items.map((k, i) => {
            const f = fired.includes(i);
            return <li key={i}><span className={`${css.glyph} ${f ? "down" : "muted"}`} aria-hidden>{f ? "●" : "○"}</span>{k}{f && <span className="down"> (fired)</span>}</li>;
          })}
        </ul>
      ) : <p className={`muted ${css.prose}`}>None</p>}
    </Panel>
  );
}

import { clock } from "./terminal/research";
import css from "./ui.module.css";

export function ResearchRunning({ done, total, elapsedS }: { done?: number; total?: number; elapsedS?: number }) {
  const parts = ["Researching", total != null ? `${done ?? 0}/${total} analysts done` : null, elapsedS != null ? clock(elapsedS) : null].filter(Boolean);
  return (
    <span className={css.status} role="status">
      <span className={css.spinner} aria-hidden /> {parts.join(" · ")}
    </span>
  );
}

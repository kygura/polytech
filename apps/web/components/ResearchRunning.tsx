import { dur } from "./fmt";
import css from "./ui.module.css";

export function ResearchRunning({ done, total, elapsedS }: { done?: number; total?: number; elapsedS?: number }) {
  const parts = ["researching", total != null ? `${done ?? 0}/${total} agents` : null, elapsedS != null ? dur(elapsedS) : null].filter(Boolean);
  return (
    <span className={css.status} role="status">
      <span className={css.spinner} aria-hidden /> {parts.join(" · ")}
    </span>
  );
}

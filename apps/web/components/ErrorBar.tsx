import css from "./ui.module.css";

export function ErrorBar({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={`${css.bar} ${css.barErr}`} role="alert">
      <span className="neg">{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  );
}

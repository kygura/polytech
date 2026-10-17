import css from "./ui.module.css";

export function ErrorBar({ message, onRetry, onDismiss }: { message: string; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className={`${css.bar} ${css.barErr}`} role="alert">
      <span className="neg">{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss">Dismiss</button>}
    </div>
  );
}

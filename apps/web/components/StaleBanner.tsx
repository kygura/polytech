import { hm } from "./fmt";
import css from "./ui.module.css";

export const STALE_MS = 5 * 60_000;

export function StaleBanner({ lastSnapshotAt, now }: { lastSnapshotAt: number | null; now: number }) {
  const min = lastSnapshotAt == null ? null : Math.round((now - lastSnapshotAt) / 60_000);
  return (
    <div className={`${css.bar} ${css.barWarn}`} role="status">
      <span className="warn">Data stale {"·"} {lastSnapshotAt == null ? "no snapshot yet" : `last snapshot ${hm(lastSnapshotAt)} (${min} min)`}</span>
    </div>
  );
}

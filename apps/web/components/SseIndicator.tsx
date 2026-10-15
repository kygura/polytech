import { hms } from "./fmt";
import css from "./ui.module.css";

export type SseStatus = "live" | "reconnecting" | "offline";
const COLOR: Record<SseStatus, string> = { live: "pos", reconnecting: "warn", offline: "neg" };

export function SseIndicator({ status, lastEventAt }: { status: SseStatus; lastEventAt: number | null }) {
  return (
    <span className={`${css.sse} ${COLOR[status]}`} title={lastEventAt ? `last event ${hms(lastEventAt)}` : "no events yet"} aria-live="polite">
      <span className={`${css.dot} ${status === "reconnecting" ? css.blink : ""}`} aria-hidden /> {status}
    </span>
  );
}

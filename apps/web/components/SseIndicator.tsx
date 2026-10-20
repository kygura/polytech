"use client";
import { useEffect, useState } from "react";
import { hms } from "./fmt";
import { nextRetry, RETRY_S, sseDetail } from "./statusbar";
import css from "./ui.module.css";

export type SseStatus = "live" | "reconnecting" | "offline";
const COLOR: Record<SseStatus, string> = { live: "pos", reconnecting: "warn", offline: "neg" };

/** Text plus dot, never a dot alone (DESIGN 12.1.1): `live · 14:02:11`, `reconnecting · 3s` (counts down to the next retry), `offline · retrying`. */
export function SseIndicator({ status, lastEventAt }: { status: SseStatus; lastEventAt: number | null }) {
  const [retryIn, setRetryIn] = useState(RETRY_S);
  useEffect(() => {
    if (status !== "reconnecting") return;
    setRetryIn(RETRY_S);
    const id = setInterval(() => setRetryIn(nextRetry), 1000);
    return () => clearInterval(id);
  }, [status]);
  return (
    <span className={`${css.sse} ${COLOR[status]}`} title={lastEventAt ? `last event ${hms(lastEventAt)}` : "no events yet"}>
      <span className={`${css.dot} ${status === "reconnecting" ? css.blink : ""}`} aria-hidden />
      {/* only the state word is announced; the ticking detail is aria-hidden */}
      <span><span role="status">{status}</span><span aria-hidden>{sseDetail(status, lastEventAt, retryIn)}</span></span>
    </span>
  );
}

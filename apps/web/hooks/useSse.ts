"use client";
import { useEffect, useRef, useState } from "react";
import type { SseStatus } from "../components/SseIndicator";

export const SSE_EVENTS = ["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.agent", "pod.failed", "pod.done", "thesis.created", "mode.changed", "paper.fill", "calibration.done", "proposal.created", "proposal.updated", "order.updated", "order.filled", "order.error", "recon.done", "set.updated"] as const;
export type SseEvent = { type: (typeof SSE_EVENTS)[number]; payload: Record<string, unknown>; ts: number };

/** One EventSource on /api/stream. `onEvent` receives typed events; ping keeps the status live. */
export function useSse(onEvent?: (e: SseEvent) => void) {
  const [status, setStatus] = useState<SseStatus>("reconnecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/api/stream");
    const touch = () => { setStatus("live"); setLastEventAt(Date.now()); };
    es.onopen = touch;
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    es.addEventListener("ping", touch);
    for (const type of SSE_EVENTS) {
      es.addEventListener(type, (m) => {
        touch();
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse((m as MessageEvent).data); } catch {}
        cb.current?.({ type, payload, ts: Date.now() });
      });
    }
    return () => es.close();
  }, []);

  return { status, lastEventAt };
}

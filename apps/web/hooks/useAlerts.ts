"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyAck, parseAlerts, type Alert } from "../components/alerts";

const getJson = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseAlerts(await r.json());
};

/** Alerts for the drawer / tab (DESIGN 12.5). While `enabled`: fetch now, on `refreshKey` change (SSE alert.created / alert.acked) and every `everyMs`. Open rows first, then (showAcked) the last 50 acked. Acks are optimistic with rollback + `error`. `onUnacked` reports every new unacked count so the status bar follows at once. */
export function useAlerts({ enabled, showAcked, refreshKey = 0, onUnacked, everyMs = 30_000 }: { enabled: boolean; showAcked: boolean; refreshKey?: number; onUnacked?: (n: number) => void; everyMs?: number }) {
  const [rows, setRows] = useState<Alert[]>([]);
  const [unacked, setUnacked] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const cb = useRef(onUnacked);
  cb.current = onUnacked;
  const publish = useCallback((n: number) => { setUnacked(n); cb.current?.(n); }, []);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const open = await getJson("/api/alerts?unacked=1&limit=100");
      if (!open) throw new Error("bad response");
      const acked = showAcked ? ((await getJson("/api/alerts?limit=200"))?.rows ?? []).filter((a) => a.ackedAt != null).slice(0, 50) : [];
      if (my !== seq.current) return; // a newer load or an ack superseded this one
      setRows([...open.rows.filter((a) => a.ackedAt == null), ...acked]);
      publish(open.unacked);
      setLoaded(true); setError(null);
    } catch (e) {
      if (my === seq.current) setError(`Alerts unavailable: ${(e as Error).message}`);
    }
  }, [showAcked, publish]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => void load(), everyMs);
    return () => clearInterval(id);
  }, [enabled, load, refreshKey, everyMs]);

  /** Ack one alert, or every open one when `id` is undefined. */
  const ack = useCallback(async (id?: number) => {
    const prev = rows, prevN = unacked;
    ++seq.current; // drop any in-flight load: it predates this ack
    const next = applyAck(rows, id, Date.now());
    setRows(next.rows); publish(next.unacked);
    try {
      const r = await fetch(id === undefined ? "/api/alerts/ack-all" : `/api/alerts/${id}/ack`, { method: "POST" });
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`); // 404 = unknown or already acked: idempotent
      setError(null);
      void load();
    } catch (e) {
      setRows(prev); publish(prevN);
      setError(`Ack failed: ${(e as Error).message}`);
    }
  }, [rows, unacked, publish, load]);

  return { rows, unacked, loaded, error, ack, reload: load, clearError: () => setError(null) };
}

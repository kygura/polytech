"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseStatus, type OpStatus } from "../components/statusbar";

/** GET /api/status (DESIGN 12.1.5) on mount, every `everyMs`, and on demand (`reload`, called from SSE events). A failed fetch keeps the last good value. `setUnacked` is the optimistic alert count. */
export function useOpStatus(everyMs = 30_000) {
  const [status, setStatus] = useState<OpStatus | null>(null);
  const busy = useRef(false);
  const reload = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    fetch("/api/status").then((r) => (r.ok ? r.json() : null)).then((j) => { const s = parseStatus(j); if (s) setStatus(s); })
      .catch(() => {}).finally(() => { busy.current = false; });
  }, []);
  useEffect(() => {
    reload();
    const id = setInterval(reload, everyMs);
    return () => clearInterval(id);
  }, [reload, everyMs]);
  const setUnacked = useCallback((n: number) => setStatus((s) => (s && s.unacked !== n ? { ...s, unacked: n } : s)), []);
  return { status, reload, setUnacked };
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type State<T> = { data: T | null; error: string | null; status: number | null; loading: boolean; lastAt: number | null; nextAt: number | null };
export type Poll<T> = State<T> & { refresh: () => void };

const init = <T,>(): State<T> => ({ data: null, error: null, status: null, loading: true, lastAt: null, nextAt: null });

/** One GET. null url = nothing to fetch (no request). Network failure and non-2xx keep `data` out of the result, so the last good data stays. */
export async function fetchOnce<T>(url: string | null, get: typeof fetch = fetch): Promise<Partial<State<T>> | null> {
  if (!url) return null;
  try {
    const r = await get(url, { cache: "no-store" });
    return r.ok ? { data: (await r.json()) as T, error: null, status: r.status, lastAt: Date.now() } : { error: `HTTP ${r.status}`, status: r.status };
  } catch {
    return { error: "network error", status: null };
  }
}

/** GET `url` as JSON every `ms`. Paused while the tab is hidden, refetched when it shows again. Keeps the last good data on error. `url` null = nothing to poll yet. */
export function usePoll<T>(url: string | null, ms: number): Poll<T> {
  const [s, set] = useState<State<T>>(init);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!url) return;
    const n = ++seq.current;
    const next = (await fetchOnce<T>(url))!;
    if (n !== seq.current) return; // superseded by a newer load or unmounted
    const visible = document.visibilityState === "visible";
    if (visible) timer.current = setTimeout(load, ms);
    set((p) => ({ ...p, ...next, loading: false, nextAt: visible ? Date.now() + ms : null }));
  }, [url, ms]);

  useEffect(() => {
    set(init<T>());
    void load();
    const wake = () => (document.visibilityState === "visible" ? void load() : clearTimeout(timer.current));
    document.addEventListener("visibilitychange", wake);
    return () => {
      seq.current++;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [load]);

  return { ...s, refresh: load };
}

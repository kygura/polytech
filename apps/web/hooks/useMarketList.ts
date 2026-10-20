"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { listUrl, type Facet, type ListRow } from "../components/terminal/marketList";

export const LIST_POLL_MS = 60_000;
export const SEARCH_DEBOUNCE_MS = 150;

type Loaded = { url: string; rows: ListRow[]; total: number };

/**
 * The /trade list: every tracked market matching `query` (name) and `cat`, refetched every 60 s. The last good rows stay on screen while a
 * new query loads or a refetch fails (DESIGN 11.7); `error` is only set when there is nothing to show. `query` is debounced 150 ms.
 */
export function useMarketList(query: string, cat: string | null) {
  const [q, setQ] = useState(query);
  useEffect(() => { const t = setTimeout(() => setQ(query), SEARCH_DEBOUNCE_MS); return () => clearTimeout(t); }, [query]);
  const url = listUrl(q, cat);
  const [last, setLast] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    fetch(url, { cache: "no-store", signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ rows: ListRow[]; total: number }>; })
      .then((j) => { setLast({ url, rows: j.rows, total: j.total }); setFailed(false); })
      .catch(() => { if (!ac.signal.aborted) setFailed(true); });
    return () => ac.abort();
  }, [url, tick]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") setTick((n) => n + 1); }, LIST_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return {
    rows: last?.rows ?? [], total: last?.total ?? 0,
    loading: last?.url !== url && !failed, error: failed && last == null,
    /** True while the shown rows belong to an older query than the box says. */
    stale: last != null && last.url !== url,
    retry: useCallback(() => { setFailed(false); setTick((n) => n + 1); }, []),
  };
}

/** Category chips: top 8 by active-market count. Empty (no chip row) until the sweep has stored categories. */
export function useCategories(): Facet[] {
  const [cats, setCats] = useState<Facet[]>([]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    fetch("/api/markets/categories").then((r) => (r.ok ? r.json() : null)).then((j: { categories?: Facet[] } | null) => { if (live.current && j?.categories) setCats(j.categories); }).catch(() => {});
    return () => { live.current = false; };
  }, []);
  return cats;
}

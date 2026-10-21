import type { Pm } from "@pm/pm";

// DESIGN 12.6.2: price-history slices for /markets/[id]. Pure helpers + the loader; the route only wires deps.
export const RANGES = ["1d", "1w", "1m", "all"] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = "1m";
export const parseRange = (v: unknown): Range | null => (RANGES as readonly unknown[]).includes(v) ? (v as Range) : null;

const H = 3_600_000;
/** Polymarket `interval` + bucket `fidelity` (minutes) per range, and the window (ms) used by the snapshot fallback (null = everything). */
export const RANGE_QUERY: Record<Range, { interval: "1d" | "1w" | "1m" | "max"; fidelity: number; windowMs: number | null }> = {
  "1d": { interval: "1d", fidelity: 5, windowMs: 24 * H },
  "1w": { interval: "1w", fidelity: 60, windowMs: 7 * 24 * H },
  "1m": { interval: "1m", fidelity: 180, windowMs: 30 * 24 * H },
  all: { interval: "max", fidelity: 1440, windowMs: null },
};

export const MAX_POINTS = 500;
const MIN_ALL_POINTS = 30;
export type HistPt = { ts: number; mid: number }; // ts = epoch ms
export type HistoryResult = { range: Range; source: "polymarket" | "snapshots"; points: HistPt[] };

/** Evenly spaced indices, first and last point always kept. */
export function downsample<T>(pts: readonly T[], max = MAX_POINTS): T[] {
  if (pts.length <= max) return [...pts];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]!);
  return out;
}

/** Polymarket `t` is unix seconds; the chart wants ms. Drops non-finite points, sorts ascending. */
export const toPoints = (h: { t: number; p: number }[]): HistPt[] =>
  h.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p)).map((x) => ({ ts: x.t * 1000, mid: x.p })).sort((a, b) => a.ts - b.ts);

export type HistoryDeps = {
  tokenId: string | null;
  pm: Pick<Pm, "pricesHistory">;
  /** Own snapshots at or after `sinceMs`, oldest first (null mid already dropped). */
  snapshots: (sinceMs: number) => Promise<HistPt[]>;
  now: number;
};

/** Polymarket first; own snapshots when the call fails or returns nothing. Always downsampled. */
export async function loadHistory(range: Range, d: HistoryDeps): Promise<HistoryResult> {
  const q = RANGE_QUERY[range];
  if (d.tokenId) {
    const get = (fidelity: number) => d.pm.pricesHistory({ token: d.tokenId!, interval: q.interval, fidelity }).then(toPoints, () => [] as HistPt[]);
    let pts = await get(q.fidelity);
    // ALL is daily buckets: a market only days old gets a handful of points, so ask again hourly (still downsampled).
    if (range === "all" && pts.length < MIN_ALL_POINTS) { const fine = await get(60); if (fine.length > pts.length) pts = fine; }
    if (pts.length) return { range, source: "polymarket", points: downsample(pts) };
  }
  const own = await d.snapshots(q.windowMs == null ? 0 : d.now - q.windowMs);
  return { range, source: "snapshots", points: downsample(own) };
}

/** Time-boxed memo with in-flight dedupe: concurrent callers of one key share one load; a rejected load is not kept. */
export function makeCache<T>(ttlMs: number, now: () => number = Date.now, maxEntries = 200) {
  const m = new Map<string, { exp: number; p: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const t = now(), hit = m.get(key);
      if (hit && hit.exp > t) return hit.p;
      if (m.size >= maxEntries) {
        for (const [k, v] of m) if (v.exp <= t) m.delete(k);
        if (m.size >= maxEntries) m.delete(m.keys().next().value!); // oldest insertion
      }
      const p = load();
      m.set(key, { exp: t + ttlMs, p });
      p.catch(() => { if (m.get(key)?.p === p) m.delete(key); });
      return p;
    },
    get size() { return m.size; },
  };
}

export const HISTORY_TTL_MS = 60_000;
export const historyCache = makeCache<HistoryResult>(HISTORY_TTL_MS);

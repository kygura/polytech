import type { Filter, Range, SortField } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { memo } from "./memo";

// Screener query: a Filter compiled to a predicate and a comparator over joined rows (markets + market_latest + market_flags +
// newest thesis per market). User values are only ever compared as data (substring / equality / numeric range): nothing is parsed
// or interpreted, so hostile strings match literally.

type MarketRow = typeof s.markets.$inferSelect;
type LatestRow = typeof s.marketLatest.$inferSelect;
type FlagRow = typeof s.marketFlags.$inferSelect;
type ThesisRow = typeof s.theses.$inferSelect;

/** One screener row: an active market with its left-joined latest/flags rows and its newest thesis (createdAt desc, id desc), each null when missing. */
export type ScreenerJoin = { m: MarketRow; ml: LatestRow | null; flags: FlagRow | null; thesis: ThesisRow | null };

const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;

/** `(opportunity->>'k')::float8`: a JSON number (or numeric string) under k, else null. */
const opp = (ml: LatestRow | null, k: "o" | "edge"): number | null => {
  const v = (ml?.opportunity as Record<string, unknown> | null | undefined)?.[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const col = (field: SortField, r: ScreenerJoin, now: number): number | null => {
  const { m, ml } = r;
  switch (field) {
    case "priority": return ml?.priority ?? null;
    case "opportunity": return opp(ml, "o");
    case "edge": return opp(ml, "edge");
    case "liquidity": return m.liquidity;
    case "volume24h": return m.vol24h;
    case "depth2c": return ml?.depth2c ?? null;
    case "spread": return ml?.spread ?? null;
    case "price": return ml?.mid ?? null;
    case "daysToResolution": return m.endDate ? (m.endDate.getTime() - now) / DAY_MS : null;
    case "stalenessHours": return ml?.lastTradeTs ? (now - ml.lastTradeTs.getTime()) / HOUR_MS : null;
    case "holderTop1Share": return ml?.top1Share ?? null;
    case "holderCount": return ml?.holderCount ?? null;
  }
};

const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
/** `<e> asc|desc nulls last`. */
const nullsLast = (a: number | null, b: number | null, dir: "asc" | "desc") =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : dir === "asc" ? cmp(a, b) : cmp(b, a);

export const DEFAULT_LIMIT = 100;

/**
 * Pure: Filter -> row predicate / comparator / paging. Statuses other than 'active' never match. `watchFirst`: pinned and live-thesis
 * rows sort ahead of the rest (the /trade list). Sort keys are `nulls last` in both directions, then conditionId (stable paging).
 */
export function compileFilter(f: Filter, now: number, watchFirst = false) {
  const c: ((r: ScreenerJoin) => boolean)[] = [(r) => r.m.status === "active"];
  const range = (field: SortField, rg?: Range) => {
    if (rg?.min !== undefined) { const min = rg.min; c.push((r) => { const v = col(field, r, now); return v !== null && v >= min; }); }
    if (rg?.max !== undefined) { const max = rg.max; c.push((r) => { const v = col(field, r, now); return v !== null && v <= max; }); }
  };
  for (const [field, rg] of [
    ["liquidity", f.liquidity], ["volume24h", f.volume24h], ["depth2c", f.depth2c], ["spread", f.spread], ["price", f.price],
    ["daysToResolution", f.daysToResolution], ["stalenessHours", f.stalenessHours], ["holderTop1Share", f.holderTop1Share],
    ["holderCount", f.holderCount], ["priority", f.priority], ["opportunity", f.opportunity], ["edge", f.edge],
  ] as const) range(field, rg);

  for (const w of f.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [])
    c.push((r) => r.m.question.toLowerCase().includes(w)); // plain substring: no wildcards. Questions only: rules text is not stored
  const lc = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const hasTag = (set: Set<string>) => (r: ScreenerJoin) => (r.m.tags ?? []).some((t) => set.has(String(t).toLowerCase()));
  if (f.tags?.length) c.push(hasTag(lc(f.tags)));
  if (f.excludeTags?.length) { const has = hasTag(lc(f.excludeTags)); c.push((r) => !has(r)); }
  if (f.categories?.length) { const set = lc(f.categories); c.push((r) => r.m.category !== null && set.has(r.m.category.toLowerCase())); }
  if (f.excludeCategories?.length) { const set = lc(f.excludeCategories); c.push((r) => !set.has((r.m.category ?? "").toLowerCase())); } // coalesce(lower(category), '') <> all(...)
  if (f.resolutionSource?.length) { const set = new Set<string>(f.resolutionSource); c.push((r) => r.m.resolutionSource !== null && set.has(r.m.resolutionSource)); }
  if (f.structural?.length) { const set = new Set<string>(f.structural); c.push((r) => (r.ml?.structural ?? []).some((k) => set.has(k))); }

  const pinned = (r: ScreenerJoin) => r.flags?.pinned ?? false, muted = (r: ScreenerJoin) => r.flags?.muted ?? false;
  const live = (r: ScreenerJoin) => r.thesis !== null && (r.thesis.expiresAt === null || r.thesis.expiresAt.getTime() > now);
  const watched = (r: ScreenerJoin) => pinned(r) || live(r); // watched = pinned or has a live (unexpired) thesis
  const bool = (e: (r: ScreenerJoin) => boolean, v: boolean | undefined) => v !== undefined && c.push(v ? e : (r) => !e(r));
  bool(watched, f.watchlisted);
  bool(pinned, f.pinned);
  bool(muted, f.muted);
  bool((r) => r.thesis !== null, f.hasThesis);

  const sorts = f.sort?.length ? f.sort : [{ field: "priority" as const, dir: "desc" as const }];
  const match = (r: ScreenerJoin) => c.every((p) => p(r));
  const compare = (a: ScreenerJoin, b: ScreenerJoin) => {
    if (watchFirst) { const d = (watched(a) ? 0 : 1) - (watched(b) ? 0 : 1); if (d) return d; }
    for (const { field, dir } of sorts) { const d = nullsLast(col(field, a, now), col(field, b, now), dir); if (d) return d; }
    return cmp(a.m.conditionId, b.m.conditionId);
  };
  return { match, compare, limit: f.limit ?? DEFAULT_LIMIT, offset: f.offset ?? 0 };
}

/** Newest thesis per market: createdAt desc, then id desc. */
const newestTheses = (rows: ThesisRow[]) => {
  const out = new Map<string, ThesisRow>();
  for (const t of rows) {
    const cur = out.get(t.conditionId);
    if (!cur || t.createdAt.getTime() > cur.createdAt.getTime() || (t.createdAt.getTime() === cur.createdAt.getTime() && t.id > cur.id)) out.set(t.conditionId, t);
  }
  return out;
};

async function joinScreener(db: Db): Promise<ScreenerJoin[]> {
  const [mk, latest, flags, ths] = await Promise.all([db.markets.find("status", { status: "active" }), db.marketLatest.all(), db.marketFlags.all(), db.theses.all()]);
  const L = new Map(latest.map((x) => [x.conditionId, x])), F = new Map(flags.map((x) => [x.conditionId, x])), T = newestTheses(ths);
  return mk.map((m) => ({ m, ml: L.get(m.conditionId) ?? null, flags: F.get(m.conditionId) ?? null, thesis: T.get(m.conditionId) ?? null }));
}

const SCREENER_MEMO = "screener:rows", SCREENER_TTL_MS = 10_000;

/**
 * Every active market joined with its latest/flags rows and newest thesis: what `compileFilter` runs over. One round trip (parallel reads).
 * On Redis each call is four full reads, so the joined rows are shared process-wide for 10 s (callers must not mutate them). The in-process
 * backend (tests, local dev) is read fresh every time.
 */
export function screenerRows(db: Db): Promise<ScreenerJoin[]> {
  return db.backend.kind === "redis" ? memo(SCREENER_MEMO, SCREENER_TTL_MS, () => joinScreener(db)) : joinScreener(db);
}

/**
 * d24c: YES mid now minus the YES mid 24 h ago, in cents. "24 h ago" = the newest snapshot at or before now - 24 h with a mid (snapshot rows
 * skip unchanged books, so an old row is still the right price). Null when the market has no snapshot that old. One batched read of the
 * condMid index, which holds only rows with a mid.
 */
export async function change24h(db: Db, ids: string[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const todo = [...new Set(ids)];
  if (!todo.length) return out;
  const got = await db.snapshots.findEach("condMid", todo.map((conditionId) => ({ conditionId })), { order: "desc", max: new Date(now - DAY_MS), limit: 1 });
  todo.forEach((id, i) => {
    const mid = got[i]?.[0]?.mid;
    if (mid != null) out.set(id, mid);
  });
  return out;
}

const LATEST_COLS = Object.keys(s.marketLatest.cols).filter((k) => k !== "conditionId") as Exclude<keyof LatestRow, "conditionId">[];
type Latest = { [K in Exclude<keyof LatestRow, "conditionId">]: LatestRow[K] | null };
/** market_latest columns of a left join: every one null when the row is missing. */
const latestOf = (ml: LatestRow | null): Latest => Object.fromEntries(LATEST_COLS.map((k) => [k, ml ? ml[k] : null])) as Latest;

export async function listMarkets(db: Db, f: Filter, now: number, o: { limit?: number; offset?: number; watchFirst?: boolean } = {}) {
  const { match, compare, limit, offset } = compileFilter(f, now, o.watchFirst);
  const hits = (await screenerRows(db)).filter(match).sort(compare);
  const from = o.offset ?? offset;
  const page = hits.slice(from, from + (o.limit ?? limit));
  const before = await change24h(db, page.map((r) => r.m.conditionId), now);
  return {
    total: hits.length,
    rows: page.map(({ m, ml, flags, thesis: t }) => {
      const mid = ml?.mid ?? null;
      return {
        conditionId: m.conditionId, question: m.question, category: m.category, tags: m.tags, endDate: m.endDate,
        liquidity: m.liquidity, vol24h: m.vol24h, resolutionSource: m.resolutionSource, negRiskAugmented: m.negRiskAugmented,
        ...latestOf(ml),
        pinned: flags?.pinned ?? false, muted: flags?.muted ?? false,
        d24c: mid != null && before.has(m.conditionId) ? (mid - before.get(m.conditionId)!) * 100 : null,
        thesis: t ? { id: t.id, side: t.side, edgeC: t.edgeC, pPost: t.pPost, expired: !!t.expiresAt && t.expiresAt.getTime() <= now } : null,
      };
    }),
  };
}

/** Category chips for the /trade list: active categories by market count, biggest first (ties by name). */
export async function topCategories(db: Db, n = 8) {
  const counts = new Map<string, number>();
  for (const m of await db.markets.find("status", { status: "active" })) if (m.category !== null) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, n).map(([category, k]) => ({ category, n: k }));
}

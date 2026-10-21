import type { Filter, Range, SortField } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { and, count, getTableColumns, sql, type SQL } from "drizzle-orm";

// Screener query: a Filter compiled to parameterized SQL over markets + market_latest + market_flags + newest thesis.
// Every user value is a bind parameter; `sql.raw` only ever receives constants from this file.

const ml = s.marketLatest, m = s.markets, th = s.theses;
const opp = (k: "o" | "edge") => sql`(${ml.opportunity}->>${sql.raw(`'${k}'`)})::float8`;
const arr = (xs: string[]) => sql`array[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[]`;

const col = (field: SortField, nowTs: SQL): SQL => {
  switch (field) {
    case "priority": return sql`${ml.priority}`;
    case "opportunity": return opp("o");
    case "edge": return opp("edge");
    case "liquidity": return sql`${m.liquidity}`;
    case "volume24h": return sql`${m.vol24h}`;
    case "depth2c": return sql`${ml.depth2c}`;
    case "spread": return sql`${ml.spread}`;
    case "price": return sql`${ml.mid}`;
    case "daysToResolution": return sql`extract(epoch from (${m.endDate} - ${nowTs})) / 86400`;
    case "stalenessHours": return sql`extract(epoch from (${nowTs} - ${ml.lastTradeTs})) / 3600`;
    case "holderTop1Share": return sql`${ml.top1Share}`;
    case "holderCount": return sql`${ml.holderCount}`;
  }
};

export const DEFAULT_LIMIT = 100;

/** Pure: Filter -> WHERE / ORDER BY / paging. Statuses other than 'active' are never listed. `watchFirst`: pinned and live-thesis rows sort ahead of the rest (the /trade list). */
export function compileFilter(f: Filter, now: number, watchFirst = false) {
  const nowTs = sql`${new Date(now).toISOString()}::timestamptz`;
  const c: SQL[] = [sql`${m.status} = 'active'`];
  const range = (e: SQL, r?: Range) => {
    if (r?.min !== undefined) c.push(sql`${e} >= ${r.min}::float8`);
    if (r?.max !== undefined) c.push(sql`${e} <= ${r.max}::float8`);
  };
  for (const [field, r] of [
    ["liquidity", f.liquidity], ["volume24h", f.volume24h], ["depth2c", f.depth2c], ["spread", f.spread], ["price", f.price],
    ["daysToResolution", f.daysToResolution], ["stalenessHours", f.stalenessHours], ["holderTop1Share", f.holderTop1Share],
    ["holderCount", f.holderCount], ["priority", f.priority], ["opportunity", f.opportunity], ["edge", f.edge],
  ] as const) range(col(field, nowTs), r);

  for (const w of f.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [])
    c.push(sql`strpos(lower(${m.question}), ${w}) > 0`); // strpos, not LIKE: no wildcard escaping. Questions only: rules text is not stored
  const lc = (xs: string[]) => arr(xs.map((x) => x.toLowerCase()));
  const hasTag = (xs: string[]) => sql`exists (select 1 from jsonb_array_elements_text(${m.tags}) tg(v) where lower(tg.v) = any(${lc(xs)}))`;
  if (f.tags?.length) c.push(hasTag(f.tags));
  if (f.excludeTags?.length) c.push(sql`not ${hasTag(f.excludeTags)}`);
  if (f.categories?.length) c.push(sql`lower(${m.category}) = any(${lc(f.categories)})`);
  if (f.excludeCategories?.length) c.push(sql`coalesce(lower(${m.category}), '') <> all(${lc(f.excludeCategories)})`);
  if (f.resolutionSource?.length) c.push(sql`${m.resolutionSource} = any(${arr(f.resolutionSource)})`);
  if (f.structural?.length) c.push(sql`jsonb_exists_any(${ml.structural}, ${arr(f.structural)})`);

  const pinned = sql`coalesce(${s.marketFlags.pinned}, false)`, muted = sql`coalesce(${s.marketFlags.muted}, false)`;
  const live = sql`(${th.id} is not null and (${th.expiresAt} is null or ${th.expiresAt} > ${nowTs}))`;
  const bool = (e: SQL, v: boolean | undefined) => v !== undefined && c.push(v ? e : sql`not ${e}`);
  bool(sql`(${pinned} or ${live})`, f.watchlisted); // watched = pinned or has a live (unexpired) thesis
  bool(pinned, f.pinned);
  bool(muted, f.muted);
  bool(sql`${th.id} is not null`, f.hasThesis);

  const orderBy = [
    ...(watchFirst ? [sql`case when (${pinned} or ${live}) then 0 else 1 end`] : []),
    ...(f.sort?.length ? f.sort : [{ field: "priority" as const, dir: "desc" as const }]).map(
      ({ field, dir }) => sql`${col(field, nowTs)} ${sql.raw(dir === "asc" ? "asc" : "desc")} nulls last`,
    ),
    sql`${m.conditionId}`, // stable paging
  ];
  return { where: and(...c)!, orderBy, limit: f.limit ?? DEFAULT_LIMIT, offset: f.offset ?? 0 };
}

const { conditionId: _id, ...latest } = getTableColumns(ml);

/** Newest thesis per market via a correlated subselect on theses_cond (condition_id), so it stays an index probe. */
const newest = sql`${th.id} = (select t2.id from theses t2 where t2.condition_id = ${m.conditionId} order by t2.created_at desc, t2.id desc limit 1)`;

const DAY_MS = 86_400_000;

/**
 * d24c: YES mid now minus the YES mid 24 h ago, in cents. "24 h ago" = the newest snapshot at or before now - 24 h (snapshot rows skip unchanged books,
 * so an old row is still the right price). Null when the market has no snapshot that old. One index probe per id on snapshots_cond_ts.
 */
export async function change24h(db: Db, ids: string[], now: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const cut = new Date(now - DAY_MS).toISOString();
  const rows = await db
    .select({ id: sql<string>`v.id`, mid: sql<number | null>`(select sn.mid from snapshots sn where sn.condition_id = v.id and sn.ts <= ${cut}::timestamptz and sn.mid is not null order by sn.ts desc limit 1)` })
    .from(sql`unnest(${arr(ids)}) as v(id)`);
  for (const r of rows) if (r.mid != null) out.set(r.id, r.mid);
  return out;
}

export async function listMarkets(db: Db, f: Filter, now: number, o: { limit?: number; offset?: number; watchFirst?: boolean } = {}) {
  const { where, orderBy, limit, offset } = compileFilter(f, now, o.watchFirst);
  const [rows, [tot]] = await Promise.all([
    db.select({
      conditionId: m.conditionId, question: m.question, category: m.category, tags: m.tags, endDate: m.endDate,
      liquidity: m.liquidity, vol24h: m.vol24h, resolutionSource: m.resolutionSource, negRiskAugmented: m.negRiskAugmented,
      ...latest,
      pinned: sql<boolean>`coalesce(${s.marketFlags.pinned}, false)`, muted: sql<boolean>`coalesce(${s.marketFlags.muted}, false)`,
      thesisId: th.id, thesisSide: th.side, thesisEdgeC: th.edgeC, thesisPPost: th.pPost, thesisExpiresAt: th.expiresAt,
    })
      .from(m).leftJoin(ml, sql`${ml.conditionId} = ${m.conditionId}`).leftJoin(s.marketFlags, sql`${s.marketFlags.conditionId} = ${m.conditionId}`).leftJoin(th, newest)
      .where(where).orderBy(...orderBy).limit(o.limit ?? limit).offset(o.offset ?? offset),
    db.select({ n: count() })
      .from(m).leftJoin(ml, sql`${ml.conditionId} = ${m.conditionId}`).leftJoin(s.marketFlags, sql`${s.marketFlags.conditionId} = ${m.conditionId}`).leftJoin(th, newest)
      .where(where),
  ]);
  const before = await change24h(db, rows.map((r) => r.conditionId), now);
  return {
    total: tot?.n ?? 0,
    rows: rows.map(({ thesisId, thesisSide, thesisEdgeC, thesisPPost, thesisExpiresAt, ...r }) => ({
      ...r,
      d24c: r.mid != null && before.has(r.conditionId) ? (r.mid - before.get(r.conditionId)!) * 100 : null,
      thesis: thesisId ? { id: thesisId, side: thesisSide!, edgeC: thesisEdgeC!, pPost: thesisPPost!, expired: !!thesisExpiresAt && thesisExpiresAt.getTime() <= now } : null,
    })),
  };
}

/** Category chips for the /trade list: active categories by market count, biggest first. */
export async function topCategories(db: Db, n = 8) {
  const rows = await db.select({ category: m.category, n: count() }).from(m).where(and(sql`${m.status} = 'active'`, sql`${m.category} is not null`)).groupBy(m.category).orderBy(sql`count(*) desc`, m.category).limit(n);
  return rows.map((r) => ({ category: r.category!, n: r.n }));
}

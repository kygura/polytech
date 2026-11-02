import { parseQuery, type Filter } from "@pm/core";
import { schema as s } from "@pm/db";
import { beforeAll, describe, expect, it } from "vitest";
import { dbReady } from "./deps";
import { change24h, compileFilter, listMarkets, topCategories, type ScreenerJoin } from "./markets";

const NOW = Date.UTC(2026, 9, 20);
const H = 3_600_000, DAY = 24 * H;

type M = typeof s.markets.$inferSelect;
type L = typeof s.marketLatest.$inferSelect;
type T = typeof s.theses.$inferSelect;
const blank = <R,>(cols: object) => Object.fromEntries(Object.keys(cols).map((k) => [k, null])) as R;
/** A joined screener row: every column present (null unless given), like the store returns them. `ml: null` = no market_latest row. */
const row = (id: string, o: { m?: Partial<M>; ml?: Partial<L> | null; flags?: { pinned?: boolean; muted?: boolean } | null; thesis?: Partial<T> | null } = {}): ScreenerJoin => ({
  m: { ...blank<M>(s.markets.cols), conditionId: id, question: `Question ${id}`, tags: [], status: "active", negRiskAugmented: false, ...o.m },
  ml: o.ml === null ? null : { ...blank<L>(s.marketLatest.cols), conditionId: id, ts: new Date(NOW), ...o.ml },
  flags: o.flags ? { conditionId: id, pinned: false, muted: false, ...o.flags } : null,
  thesis: o.thesis ? { ...blank<T>(s.theses.cols), id: `t-${id}`, conditionId: id, podId: "p", side: "YES", pHat: 0.5, c: 0.5, pPost: 0.5, edgeC: 3, sizeUsd: 10, catalysts: [], killCriteria: [], createdAt: new Date(NOW - H), ...o.thesis } : null,
});

const compile = (q: string) => {
  const { filter, errors } = parseQuery(q);
  expect(errors).toEqual([]);
  return { filter, ...compileFilter(filter, NOW) };
};
/** The ids a compiled filter lists, in its order. */
const run = (c: ReturnType<typeof compileFilter>, rows: ScreenerJoin[]) => rows.filter(c.match).sort(c.compare).map((r) => r.m.conditionId);

describe("compileFilter", () => {
  it("default: active only, priority desc nulls last, stable tiebreak, limit 100", () => {
    const c = compile("");
    const rows = [
      row("0xe", { ml: { priority: null } }), row("0xd", { ml: { priority: 0.2 } }), row("0xc", { ml: { priority: 0.9 } }), row("0xb", { ml: { priority: 0.2 } }),
      row("0xa", { ml: null }), // no market_latest row: priority null
      row("0xf", { m: { status: "closed" }, ml: { priority: 5 } }), row("0x0", { m: { status: "resolved" }, ml: { priority: 5 } }),
    ];
    expect(run(c, rows)).toEqual(["0xc", "0xb", "0xd", "0xa", "0xe"]); // nulls last; equal keys by conditionId
    expect([c.limit, c.offset]).toEqual([100, 0]);
  });

  it("ranges (inclusive bounds, null never matches), sort, paging", () => {
    const c = compile("liq:5k..50k depth:>1k sort:-vol24h,spread limit:25 offset:50");
    expect(c.filter).toMatchObject({ liquidity: { min: 5000, max: 50000 }, depth2c: { min: 1000 } });
    const ok = (id: string, liquidity: number | null, depth2c: number | null, extra: { vol24h?: number | null; spread?: number | null } = {}) =>
      row(id, { m: { liquidity, vol24h: extra.vol24h ?? null }, ml: { depth2c, spread: extra.spread ?? null } });
    expect(c.match(ok("a", 5000, 1000))).toBe(true);
    expect(c.match(ok("a", 50000, 1e6))).toBe(true);
    expect(c.match(ok("a", 4999, 1000))).toBe(false);
    expect(c.match(ok("a", 50001, 1000))).toBe(false);
    expect(c.match(ok("a", null, 1000))).toBe(false);
    expect(c.match(ok("a", 6000, 999))).toBe(false);
    expect(c.match(ok("a", 6000, null))).toBe(false);
    expect(c.match(row("a", { m: { liquidity: 6000 }, ml: null }))).toBe(false); // no market_latest row: depth is null
    // vol24h desc nulls last, then spread asc nulls last, then conditionId
    const rows = [
      ok("0x1", 6000, 2000, { vol24h: null, spread: 0.01 }), ok("0x2", 6000, 2000, { vol24h: 10, spread: null }), ok("0x3", 6000, 2000, { vol24h: 10, spread: 0.05 }),
      ok("0x4", 6000, 2000, { vol24h: 20, spread: 0.5 }), ok("0x5", 6000, 2000, { vol24h: 10, spread: 0.01 }), ok("0x6", 6000, 2000, { vol24h: null, spread: 0.01 }),
    ];
    expect(run(c, rows)).toEqual(["0x4", "0x5", "0x3", "0x2", "0x1", "0x6"]);
    expect([c.limit, c.offset]).toEqual([25, 50]);
  });

  it("hostile strings are matched literally, never interpreted", () => {
    const evil = `x'); drop table markets; --`;
    const { filter } = parseQuery(`cat:"${evil}" tag:"${evil}" "${evil}"`);
    const all = compileFilter({ ...filter, text: evil, tags: [evil], excludeTags: [evil], categories: [evil], excludeCategories: [evil] }, NOW);
    const target = row("0xe", { m: { question: `Will ${evil} happen?`, category: evil, tags: [evil] } });
    const plain = row("0xp", { m: { question: "drop table markets", category: "politics", tags: ["politics"] } });
    // include and exclude of the same literal value contradict: nothing lists, and nothing throws
    expect(run(all, [target, plain])).toEqual([]);

    const only = (f: Filter, rows: ScreenerJoin[]) => run(compileFilter(f, NOW), rows);
    const upper = row("0xu", { m: { question: `WILL ${evil.toUpperCase()}?`, category: evil.toUpperCase(), tags: [evil.toUpperCase()] } });
    const noCat = row("0xn", { m: { category: null } });
    const rows = [target, plain, upper, noCat];
    expect(only({ text: evil }, rows)).toEqual(["0xe", "0xu"]); // every word as a plain, case-insensitive substring
    expect(only({ categories: [evil] }, rows)).toEqual(["0xe", "0xu"]);
    expect(only({ excludeCategories: [evil] }, rows)).toEqual(["0xn", "0xp"]); // null category stays (coalesce to '')
    expect(only({ tags: [evil] }, rows)).toEqual(["0xe", "0xu"]);
    expect(only({ excludeTags: [evil] }, rows)).toEqual(["0xn", "0xp"]);
    // wildcard / pattern characters are literal too: no LIKE, no regex
    const pats = [row("0x1", { m: { question: "50% chance", tags: ["a%b"], category: "a_b" } }), row("0x2", { m: { question: "abc", tags: ["axb"], category: "axb" } })];
    for (const w of ["%", "_", ".*", "a.c", "[a-z]", "\\"]) expect(only({ text: w }, pats)).toEqual(pats.filter((p) => p.m.question.includes(w)).map((p) => p.m.conditionId));
    expect(only({ tags: ["a%b"] }, pats)).toEqual(["0x1"]);
    expect(only({ tags: [".*"] }, pats)).toEqual([]);
    expect(only({ categories: ["a_b"] }, pats)).toEqual(["0x1"]);
    expect(only({ categories: ["%"] }, pats)).toEqual([]);
    expect(only({ resolutionSource: [evil as never] }, [row("0xr", { m: { resolutionSource: "official_data" } })])).toEqual([]);
  });

  it("flags, thesis, src, struct, opportunity jsonb", () => {
    const c = compile("is:watch -is:muted has:thesis src:off struct:over opp:>0.01 edge:>3%");
    expect(c.filter).toMatchObject({ watchlisted: true, muted: false, hasThesis: true, resolutionSource: ["official_data"], structural: ["overround"], opportunity: { min: 0.01 }, edge: { min: 0.03 } });
    const base = { m: { resolutionSource: "official_data" }, ml: { structural: ["sibling_inconsistency", "overround"], opportunity: { side: "YES", edge: 0.05, stake: 1, o: 0.02, contrarian: false } }, thesis: { expiresAt: null } };
    const ok = (o: Parameters<typeof row>[1] = {}) => c.match(row("0xa", { ...base, ...o }));
    expect(ok()).toBe(true); // no flags row reads as not pinned, not muted; a thesis without expiry is live, so watched
    expect(ok({ flags: { muted: true } })).toBe(false);
    expect(ok({ thesis: { expiresAt: new Date(NOW - 1) } })).toBe(false); // expired thesis, not pinned: not watched
    expect(ok({ thesis: { expiresAt: new Date(NOW) } })).toBe(false); // expiresAt > now, strictly
    expect(ok({ thesis: { expiresAt: new Date(NOW + 1) } })).toBe(true);
    expect(ok({ thesis: { expiresAt: new Date(NOW - 1) }, flags: { pinned: true } })).toBe(true); // pinned is watched
    expect(ok({ thesis: null, flags: { pinned: true } })).toBe(false); // has:thesis
    expect(ok({ m: { resolutionSource: "media_report" } })).toBe(false);
    expect(ok({ m: { resolutionSource: null } })).toBe(false);
    expect(ok({ ml: { ...base.ml, structural: ["monotonicity_violation"] } })).toBe(false);
    expect(ok({ ml: { ...base.ml, structural: null } })).toBe(false);
    expect(ok({ ml: null })).toBe(false);
    expect(ok({ ml: { ...base.ml, opportunity: null } })).toBe(false);
    expect(ok({ ml: { ...base.ml, opportunity: { ...base.ml.opportunity, o: 0.01, edge: 0.03 } } })).toBe(true); // inclusive
    expect(ok({ ml: { ...base.ml, opportunity: { ...base.ml.opportunity, edge: 0.029 } } })).toBe(false);
    // negations: not watched / not pinned / no thesis
    const neg = compileFilter({ watchlisted: false, pinned: false, hasThesis: false }, NOW);
    expect(neg.match(row("0xa"))).toBe(true);
    expect(neg.match(row("0xa", { flags: { pinned: true } }))).toBe(false);
    expect(neg.match(row("0xa", { thesis: { expiresAt: new Date(NOW - 1) } }))).toBe(false); // expired thesis: not watched, but has one
  });

  it("now-relative ranges: days to resolution and hours since the last trade", () => {
    const c = compile("days:<7 stale:>48");
    const r = (endDays: number | null, tradeH: number | null) =>
      row("0xa", { m: { endDate: endDays == null ? null : new Date(NOW + endDays * DAY) }, ml: { lastTradeTs: tradeH == null ? null : new Date(NOW - tradeH * H) } });
    expect(c.match(r(7, 48))).toBe(true);
    expect(c.match(r(-1, 100))).toBe(true);
    expect(c.match(r(7.01, 48))).toBe(false);
    expect(c.match(r(3, 47))).toBe(false);
    expect(c.match(r(null, 100))).toBe(false);
    expect(c.match(r(3, null))).toBe(false);
    const asc = compileFilter({ sort: [{ field: "daysToResolution", dir: "asc" }] }, NOW);
    expect(run(asc, [row("0x1", { m: { endDate: null } }), row("0x2", { m: { endDate: new Date(NOW + 5 * DAY) } }), row("0x3", { m: { endDate: new Date(NOW - DAY) } })])).toEqual(["0x3", "0x2", "0x1"]);
  });
});

describe("d24c and /trade list ordering", () => {
  beforeAll(async () => { await dbReady(); });
  const at = (hAgo: number) => new Date(NOW - hAgo * H);
  const mk = (id: string, category: string | null) => ({ conditionId: id, question: `Question ${id}`, category, status: "active" });
  const seed = async () => {
    const db = await dbReady();
    await Promise.all([mk("0xa", "politics"), mk("0xb", "politics"), mk("0xc", "sports"), mk("0xd", null)].map((m) => db.markets.insertIfAbsent(m)));
    await Promise.all([
      { conditionId: "0xa", mid: 0.46 }, { conditionId: "0xb", mid: 0.3 }, { conditionId: "0xc", mid: 0.2 }, { conditionId: "0xd", mid: 0.5 },
    ].map((r) => db.marketLatest.insertIfAbsent(r)));
    await db.snapshots.insertMany([
      { conditionId: "0xa", ts: at(30), mid: 0.4 }, { conditionId: "0xa", ts: at(25), mid: 0.45 }, { conditionId: "0xa", ts: at(2), mid: 0.9 }, // 0.45 is the mid 24 h ago
      { conditionId: "0xb", ts: at(5), mid: 0.1 },  // nothing older than 24 h
      { conditionId: "0xc", ts: at(48), mid: 0.25 }, // old row still stands: the book did not change since
    ]);
    return db;
  };

  it("d24c = mid now - the newest snapshot mid at or before 24 h ago, in cents; null when there is none that old", async () => {
    const db = await seed();
    const before = await change24h(db, ["0xa", "0xb", "0xc", "0xd"], NOW);
    expect([...before.entries()].sort()).toEqual([["0xa", 0.45], ["0xc", 0.25]]);
    const { rows } = await listMarkets(db, { sort: [{ field: "price", dir: "desc" }] }, NOW);
    const d = Object.fromEntries(rows.map((r) => [r.conditionId, r.d24c]));
    expect(d["0xa"]).toBeCloseTo(1, 6);   // 0.46 - 0.45
    expect(d["0xc"]).toBeCloseTo(-5, 6);  // 0.20 - 0.25
    expect(d["0xb"]).toBeNull();
    expect(d["0xd"]).toBeNull();
    expect(await change24h(db, [], NOW)).toEqual(new Map());
  });

  it("d24c skips snapshots without a mid, however many sit in front of an older priced one", async () => {
    const db = await dbReady();
    await db.markets.insertIfAbsent(mk("0xz", null));
    await db.snapshots.insertMany([
      { conditionId: "0xz", ts: at(40), mid: 0.33 }, { conditionId: "0xz", ts: at(23), mid: 0.9 }, // newer than 24 h ago: not used
      ...Array.from({ length: 9 }, (_, i) => ({ conditionId: "0xz", ts: at(25 + i), mid: null })), // empty books between
    ]);
    expect((await change24h(db, ["0xz"], NOW)).get("0xz")).toBe(0.33);
    await db.markets.delete("0xz");
  });

  it("text search runs over every tracked market; watchFirst puts pinned rows ahead of the sort", async () => {
    const db = await seed();
    await db.marketFlags.insertIfAbsent({ conditionId: "0xd", pinned: true });
    const f = { text: "question", sort: [{ field: "price" as const, dir: "asc" as const }] };
    expect((await listMarkets(db, f, NOW)).rows.map((r) => r.conditionId)).toEqual(["0xc", "0xb", "0xa", "0xd"]);
    expect((await listMarkets(db, f, NOW, { watchFirst: true })).rows.map((r) => r.conditionId)).toEqual(["0xd", "0xc", "0xb", "0xa"]);
    expect((await listMarkets(db, { text: "nomatch" }, NOW)).rows).toEqual([]);
  });

  it("topCategories counts active markets by category and skips null", async () => {
    const db = await seed();
    expect((await topCategories(db, 8)).slice(0, 2)).toEqual([{ category: "politics", n: 2 }, { category: "sports", n: 1 }]);
    expect(await topCategories(db, 1)).toEqual([{ category: "politics", n: 2 }]);
  });
});

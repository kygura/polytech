import { parseQuery } from "@pm/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema as s } from "@pm/db";
import { beforeAll, describe, expect, it } from "vitest";
import { dbReady } from "./deps";
import { change24h, compileFilter, listMarkets, topCategories } from "./markets";

process.env.PGLITE_DIR = "memory://";

const NOW = Date.UTC(2026, 9, 20);
const compile = (q: string) => {
  const { filter, errors } = parseQuery(q);
  expect(errors).toEqual([]);
  const c = compileFilter(filter, NOW);
  const d = new PgDialect();
  return { where: d.sqlToQuery(c.where), order: c.orderBy.map((o) => d.sqlToQuery(o)), limit: c.limit, offset: c.offset };
};

describe("compileFilter", () => {
  it("default: active only, priority desc nulls last, stable tiebreak, limit 100", () => {
    const c = compile("");
    expect(c.where.sql).toContain(`"markets"."status" = 'active'`);
    expect(c.order[0]!.sql).toMatch(/"market_latest"\."priority" desc nulls last/);
    expect(c.order.at(-1)!.sql).toBe(`"markets"."condition_id"`);
    expect([c.limit, c.offset]).toEqual([100, 0]);
  });

  it("ranges, sort, paging map to bound parameters", () => {
    const c = compile("liq:5k..50k depth:>1k sort:-vol24h,spread limit:25 offset:50");
    expect(c.where.sql).toContain(`"markets"."liquidity" >= $`);
    expect(c.where.sql).toContain(`"market_latest"."depth_2c" >= $`);
    expect(c.where.params).toEqual(expect.arrayContaining([5000, 50000, 1000]));
    expect(c.order[0]!.sql).toMatch(/"vol_24h" desc nulls last/);
    expect(c.order[1]!.sql).toMatch(/"spread" asc nulls last/);
    expect([c.limit, c.offset]).toEqual([25, 50]);
  });

  it("never interpolates user input into SQL text", () => {
    const evil = `x'); drop table markets; --`;
    const { filter } = parseQuery(`cat:"${evil}" tag:"${evil}" "${evil}"`);
    const c = compileFilter({ ...filter, text: evil, tags: [evil], excludeTags: [evil], categories: [evil], excludeCategories: [evil] }, NOW);
    const q = new PgDialect().sqlToQuery(c.where);
    expect(q.sql).not.toMatch(/drop table/i);
    expect(q.params.some((p) => typeof p === "string" && p.includes("drop table"))).toBe(true);
  });

  it("flags, thesis, src, struct, opportunity jsonb", () => {
    const c = compile("is:watch -is:muted has:thesis src:off struct:over opp:>0.01 edge:>3%");
    expect(c.where.sql).toContain("coalesce");
    expect(c.where.sql).toContain("jsonb_exists_any");
    expect(c.where.sql).toContain(`->>'o'`);
    expect(c.where.sql).toContain(`->>'edge'`);
    expect(c.where.params).toEqual(expect.arrayContaining(["official_data", "overround", 0.01, 0.03]));
  });
});

describe("d24c and /trade list ordering", () => {
  beforeAll(async () => { await dbReady(); }, 60_000); // first use migrates the in-memory PGlite
  const H = 3_600_000, at = (hAgo: number) => new Date(NOW - hAgo * H);
  const mk = (id: string, category: string | null) => ({ conditionId: id, question: `Question ${id}`, category, status: "active" });
  const seed = async () => {
    const db = await dbReady();
    await db.insert(s.markets).values([mk("0xa", "politics"), mk("0xb", "politics"), mk("0xc", "sports"), mk("0xd", null)]).onConflictDoNothing();
    await db.insert(s.marketLatest).values([
      { conditionId: "0xa", mid: 0.46 }, { conditionId: "0xb", mid: 0.3 }, { conditionId: "0xc", mid: 0.2 }, { conditionId: "0xd", mid: 0.5 },
    ]).onConflictDoNothing();
    await db.insert(s.snapshots).values([
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

  it("text search runs over every tracked market; watchFirst puts pinned rows ahead of the sort", async () => {
    const db = await seed();
    await db.insert(s.marketFlags).values({ conditionId: "0xd", pinned: true }).onConflictDoNothing();
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

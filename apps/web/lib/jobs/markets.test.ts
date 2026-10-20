import { parseQuery } from "@pm/core";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { compileFilter } from "./markets";

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

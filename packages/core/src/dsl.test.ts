import { describe, expect, test } from "vitest";
import { DSL_KEYS, FilterSchema, SORT_FIELDS, canonicalSortField, formatQuery, parseQuery, type Filter } from "./dsl";

const ok = (q: string): Filter => {
  const r = parseQuery(q);
  expect(r.errors).toEqual([]);
  return r.filter;
};

describe("parseQuery", () => {
  test("empty / whitespace", () => {
    expect(parseQuery("")).toEqual({ filter: {}, errors: [] });
    expect(parseQuery("   ")).toEqual({ filter: {}, errors: [] });
  });
  test("spec example", () => {
    const f = ok("liq:5k..50k vol24h:<2k tag:politics,-sports days:7..90 spread:<0.04 price:0.05..0.95 src:official_data sort:-prio");
    expect(f).toEqual({
      liquidity: { min: 5000, max: 50000 },
      volume24h: { max: 2000 },
      tags: ["politics"],
      excludeTags: ["sports"],
      daysToResolution: { min: 7, max: 90 },
      spread: { max: 0.04 },
      price: { min: 0.05, max: 0.95 },
      resolutionSource: ["official_data"],
      sort: [{ field: "priority", dir: "desc" }],
    });
  });
  test("range forms and suffixes", () => {
    expect(ok("liq:>1.2m").liquidity).toEqual({ min: 1_200_000 });
    expect(ok("liq:>=2k").liquidity).toEqual({ min: 2000 });
    expect(ok("liq:<=75k").liquidity).toEqual({ max: 75000 });
    expect(ok("liq:2k..").liquidity).toEqual({ min: 2000 });
    expect(ok("liq:..2k").liquidity).toEqual({ max: 2000 });
    expect(ok("liq:5k").liquidity).toEqual({ min: 5000, max: 5000 });
    expect(ok("price:5%..95%").price).toEqual({ min: 0.05, max: 0.95 });
    expect(ok("liq:1.1m").liquidity).toEqual({ min: 1_100_000, max: 1_100_000 });
    expect(ok("liq:$2k..$5K").liquidity).toEqual({ min: 2000, max: 5000 });
    expect(ok("LIQ:2k..3k").liquidity).toEqual({ min: 2000, max: 3000 });
  });
  test("aliases", () => {
    expect(ok("liquidity:1k..2k")).toEqual(ok("liq:1k..2k"));
    expect(ok("depth:>1k").depth2c).toEqual({ min: 1000 });
    expect(ok("depth2c:>1k").depth2c).toEqual({ min: 1000 });
    expect(ok("stale:>48").stalenessHours).toEqual({ min: 48 });
    expect(ok("top1:>0.5").holderTop1Share).toEqual({ min: 0.5 });
    expect(ok("holders:<20").holderCount).toEqual({ max: 20 });
    expect(ok("prio:>0.6").priority).toEqual({ min: 0.6 });
    expect(ok("priority:>0.6")).toEqual(ok("prio:>0.6"));
    expect(ok("opp:>0.01").opportunity).toEqual({ min: 0.01 });
    expect(ok("edge:>3%").edge).toEqual({ min: 0.03 });
    expect(ok("edge:0.02..0.1").edge).toEqual({ min: 0.02, max: 0.1 });
  });
  test("repeat range key merges bounds", () => {
    expect(ok("liq:>2k liq:<50k").liquidity).toEqual({ min: 2000, max: 50000 });
  });
  test("lists", () => {
    expect(ok("tag:a,b tag:-c").tags).toEqual(["a", "b"]);
    expect(ok("tag:a,b tag:-c").excludeTags).toEqual(["c"]);
    expect(ok("src:official_data,scheduled_event").resolutionSource).toEqual(["official_data", "scheduled_event"]);
    expect(ok("src:off,sch,media,sub,unk").resolutionSource).toEqual(["official_data", "scheduled_event", "media_report", "subjective", "unknown"]);
    expect(ok("struct:overround").structural).toEqual(["overround"]);
    expect(ok("struct:mono,sibling").structural).toEqual(["monotonicity_violation", "sibling_inconsistency"]);
    expect(ok("tag:a,a").tags).toEqual(["a"]);
    expect(ok("cat:politics,-sports cat:econ")).toEqual({ categories: ["politics", "econ"], excludeCategories: ["sports"] });
    expect(ok("category:x").categories).toEqual(["x"]);
    expect(ok("struct:over").structural).toEqual(["overround"]);
  });
  test("flags", () => {
    expect(ok("is:watch").watchlisted).toBe(true);
    expect(ok("-is:watch").watchlisted).toBe(false);
    expect(ok("is:pinned").pinned).toBe(true);
    expect(ok("-is:muted").muted).toBe(false);
    expect(ok("is:watch is:pinned -is:muted")).toEqual({ watchlisted: true, pinned: true, muted: false });
    expect(ok("has:thesis").hasThesis).toBe(true);
    expect(ok("-has:thesis").hasThesis).toBe(false);
  });
  test("sort", () => {
    expect(ok("sort:-prio,vol24h").sort).toEqual([
      { field: "priority", dir: "desc" },
      { field: "volume24h", dir: "asc" },
    ]);
    expect(ok("sort:-opp,+liq,-days,-edge").sort).toEqual([
      { field: "opportunity", dir: "desc" },
      { field: "liquidity", dir: "asc" },
      { field: "daysToResolution", dir: "desc" },
      { field: "edge", dir: "desc" },
    ]);
    expect(SORT_FIELDS).toContain("priority");
    expect(canonicalSortField("prio")).toBe("priority");
    expect(canonicalSortField("mid")).toBe("price");
    expect(canonicalSortField("nope")).toBeNull();
  });
  test("limit/offset", () => {
    const f = ok("limit:50 offset:100");
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(100);
  });
  test("bare words and quotes become text", () => {
    expect(ok("cpi report").text).toBe("cpi report");
    expect(ok('"fed cut" liq:>2k').text).toBe("fed cut");
    expect(ok("fed liq:>2k cut").text).toBe("fed cut");
    expect(ok("3:30 pm").text).toBe("3:30 pm");
    expect(ok("-foo").text).toBe("-foo");
  });
  test("errors never throw and carry token/col", () => {
    const r = parseQuery("liq:abc foo:1 spread:5..1 src:bogus sort:zzz limit:0 is:what tag: struct:x has:what cat:");
    const tokens = r.errors.map((e) => e.token);
    expect(tokens).toEqual(["liq:abc", "foo:1", "spread:5..1", "src:bogus", "sort:zzz", "limit:0", "is:what", "tag:", "struct:x", "has:what", "cat:"]);
    expect(r.errors[0]!.col).toBe(0);
    expect(r.errors[1]!.col).toBe(8);
    for (const e of r.errors) expect(e.message.length).toBeGreaterThan(0);
    expect(r.filter.liquidity).toBeUndefined();
  });
  test("unknown key suggests nearest", () => {
    const r = parseQuery("liqu:5k");
    expect(r.errors[0]!.suggestion).toBe("liq");
    expect(parseQuery("zzzzzz:1").errors[0]!.suggestion).toBeUndefined();
    expect(parseQuery("categroy:x").errors[0]!.suggestion).toBe("category");
    expect(parseQuery("is:pined").errors[0]!.suggestion).toBe("pinned");
    expect(parseQuery("has:thesys").errors[0]!.suggestion).toBe("thesis");
    expect(parseQuery("struct:overrund").errors[0]!.suggestion).toBe("overround");
    expect(parseQuery("sort:-prioritty").errors[0]!.suggestion).toBe("priority");
  });
  test("-key: on non is/has keys is an error, not text", () => {
    const r = parseQuery("-liq:5k -tag:politics -cat:x -foo:1 -bare");
    expect(r.errors.map((e) => e.token)).toEqual(["-liq:5k", "-tag:politics", "-cat:x"]);
    expect(r.filter.text).toBe("-foo:1 -bare");
    expect(r.filter.liquidity).toBeUndefined();
  });
  test("merged ranges with min > max are an error", () => {
    const r = parseQuery("liq:>50k liq:<2k");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.token).toBe("liq:<2k");
    expect(r.filter.liquidity).toEqual({ min: 50000 });
    expect(parseQuery("liq:>2k liq:<50k").errors).toEqual([]);
  });
  test("garbage never throws", () => {
    for (const q of [":", "::", "..", "liq:..", "liq:<", "liq:1..2..3", "liq:NaN", "liq:Infinity", "sort:", "sort:-", "a:b:c", "\"", "-", "liq:-5..-1"]) {
      expect(() => parseQuery(q)).not.toThrow();
    }
    expect(parseQuery("liq:..").errors).toHaveLength(1);
    expect(parseQuery("liq:Infinity").errors).toHaveLength(1);
    expect(parseQuery("liq:-5..-1").filter.liquidity).toEqual({ min: -5, max: -1 });
  });
});

describe("formatQuery", () => {
  const filters: Filter[] = [
    {},
    { text: "cpi report" },
    { liquidity: { min: 5000, max: 50000 }, volume24h: { max: 2000 }, price: { min: 0.05, max: 0.95 } },
    { liquidity: { min: 1_200_000 }, spread: { max: 0.04 }, depth2c: { min: 1500 } },
    { categories: ["politics"], excludeCategories: ["sports"], excludeTags: ["x"] },
    { watchlisted: true, pinned: false, muted: true, hasThesis: false, edge: { min: 0.03 }, priority: { min: 0.5 } },
    { tags: ["politics", "econ"], excludeTags: ["sports"], resolutionSource: ["official_data", "media_report"] },
    { structural: ["overround", "sibling_inconsistency"], watchlisted: true },
    { sort: [{ field: "priority", dir: "desc" }, { field: "liquidity", dir: "asc" }], limit: 25, offset: 50 },
    { liquidity: { min: 1_100_000, max: 1_100_000 }, holderTop1Share: { min: 0.5 }, daysToResolution: { min: 3, max: 120 } },
    { text: "fed: cut", opportunity: { min: 0.0123 }, priority: { max: 0.7 }, stalenessHours: { min: 48 }, holderCount: { max: 20 } },
  ];
  test("round-trips", () => {
    for (const f of filters) {
      const q = formatQuery(f);
      const r = parseQuery(q);
      expect(r.errors).toEqual([]);
      expect(r.filter).toEqual(f);
    }
  });
  test("tiny / huge values never use exponent notation and round-trip", () => {
    for (const f of [
      { spread: { min: 1e-7, max: 0.5 } }, { price: { max: 1.5e-9 } }, { liquidity: { min: 1e21 } },
      { liquidity: { min: 2.5e22, max: 3e23 } }, { holderTop1Share: { min: -1e-8 } },
    ] as Filter[]) {
      const q = formatQuery(f);
      expect(q).not.toMatch(/e[+-]?\d/);
      expect(parseQuery(q)).toEqual({ filter: f, errors: [] });
    }
  });
  test("shape", () => {
    expect(formatQuery({ liquidity: { min: 5000, max: 50000 } })).toBe("liq:5k..50k");
    expect(formatQuery({ sort: [{ field: "priority", dir: "desc" }] })).toBe("sort:-prio");
    expect(formatQuery({ categories: ["a"], excludeCategories: ["b"], pinned: true, hasThesis: false })).toBe("cat:a,-b is:pinned -has:thesis");
    expect(formatQuery({ tags: ["a"], excludeTags: ["b"] })).toBe("tag:a,-b");
  });
  test("ignores empty ranges/arrays", () => {
    expect(formatQuery({ liquidity: {}, tags: [] })).toBe("");
  });
});

describe("DSL_KEYS", () => {
  test("lists keys with descriptions", () => {
    const keys = DSL_KEYS.map((k) => k.key);
    for (const k of ["liq", "vol24h", "depth", "spread", "price", "days", "stale", "top1", "holders", "tag", "src", "struct", "cat", "prio", "opp", "edge", "sort", "is", "has"]) {
      expect(keys).toContain(k);
    }
    for (const k of DSL_KEYS) expect(k.description.length).toBeGreaterThan(3);
  });
});

describe("FilterSchema", () => {
  test("accepts parsed filters", () => {
    const f = ok("liq:>1k cat:a,-b is:pinned has:thesis sort:-edge limit:10");
    expect(FilterSchema.parse(f)).toEqual(f);
  });
});

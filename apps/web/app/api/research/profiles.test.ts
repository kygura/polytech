import { schema as s } from "@pm/db";
import { ProfileFilterSchema, DEFAULT_STEERING } from "@pm/core";
import { beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";

const NOW = Date.parse("2026-10-15T12:00:00Z"), DAY = 86_400_000;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const F = (o: object = {}) => ProfileFilterSchema.parse(o);

let j: typeof import("../../../lib/jobs"), db: Awaited<ReturnType<typeof import("../../../lib/jobs").dbReady>>;
const ids = async (f: object) => (await j.matchMarkets(db, F(f), NOW)).map((r) => r.conditionId);

// Fixtures: a..e, all active unless noted.
beforeAll(async () => {
  j = await import("../../../lib/jobs");
  db = await j.dbReady();
  const m = (c: string, o: object) => ({ conditionId: c, question: `Question ${c}`, status: "active", ...o });
  await db.insert(s.markets).values([
    m("a", { category: "Politics", tags: ["us", "election"], vol24h: 1000, endDate: new Date(NOW + 5 * DAY), question: "Will Alpha win?" }),
    m("b", { category: "crypto", tags: ["btc"], vol24h: 5000, endDate: new Date(NOW + 20 * DAY) }),
    m("c", { category: "politics", tags: [], vol24h: 300, endDate: new Date(NOW + 60 * DAY) }),
    m("d", { category: "sports", tags: ["nba"], vol24h: 9000, endDate: null }),
    m("e", { category: "politics", tags: ["us"], vol24h: 7000, endDate: new Date(NOW + 1 * DAY), status: "closed" }),
  ]);
  const snap = (c: string, bid: number, ask: number, depth: number) => ({ conditionId: c, ts: new Date(NOW), bestBid: bid, bestAsk: ask, depth5cUsd: depth });
  await db.insert(s.snapshots).values([
    { conditionId: "a", ts: new Date(NOW - DAY), bestBid: 0.1, bestAsk: 0.9, depth5cUsd: 1 }, // stale, ignored
    snap("a", 0.48, 0.5, 800), snap("b", 0.4, 0.46, 200), snap("c", 0.5, 0.51, 5000),
  ]); // d has no snapshot
  await db.insert(s.screens).values([{ conditionId: "a", ts: new Date(NOW), priority: 1 }, { conditionId: "b", ts: new Date(NOW), priority: 3 }, { conditionId: "c", ts: new Date(NOW), priority: 2 }]);
  const th = (id: string, c: string, edgeC: number, at: number) => ({ id, conditionId: c, podId: "p", pHat: 0.5, c: 0.5, pPost: 0.5, side: "YES", edgeC, sizeUsd: 10, createdAt: new Date(at) });
  await db.insert(s.theses).values([th("t0", "a", 0.9, NOW - 3 * DAY), th("t1", "a", 0.05, NOW - DAY), th("t2", "b", -0.2, NOW - DAY)]); // a's latest edge is 0.05
}, 60_000);

describe("matchMarkets", () => {
  it("no predicates: active only, default priority sort", async () => {
    expect(await ids({})).toEqual(["b", "c", "a", "d"]); // d: no screen -> last
  });
  it("categories (case-insensitive)", async () => expect((await ids({ categories: ["POLITICS"], sort: "vol24h" }))).toEqual(["a", "c"]));
  it("tagsAny", async () => expect(await ids({ tagsAny: ["btc", "nba"], sort: "vol24h" })).toEqual(["d", "b"]));
  it("textQuery", async () => expect(await ids({ textQuery: "alpha" })).toEqual(["a"]));
  it("minVol24h", async () => expect(await ids({ minVol24h: 1000, sort: "vol24h" })).toEqual(["d", "b", "a"]));
  it("minDepthUsd (latest snapshot; no snapshot fails)", async () => expect(await ids({ minDepthUsd: 500, sort: "vol24h" })).toEqual(["a", "c"]));
  it("maxSpread (latest snapshot; no snapshot fails)", async () => expect(await ids({ maxSpread: 0.03, sort: "vol24h" })).toEqual(["a", "c"]));
  it("endsWithinDays min/max; no end date fails when set", async () => {
    expect(await ids({ endsWithinDays: { max: 30 }, sort: "endDate" })).toEqual(["a", "b"]);
    expect(await ids({ endsWithinDays: { min: 10 }, sort: "endDate" })).toEqual(["b", "c"]);
    expect(await ids({ endsWithinDays: { min: 10, max: 30 } })).toEqual(["b"]);
  });
  it("minAbsEdge uses latest thesis |edge|; no thesis fails when set", async () => {
    expect(await ids({ minAbsEdge: 0.1 })).toEqual(["b"]);
    expect(await ids({ minAbsEdge: 0.01, sort: "edge" })).toEqual(["b", "a"]);
  });
  it("include / exclude ids", async () => {
    expect(await ids({ includeConditionIds: ["a", "c", "e"], sort: "vol24h" })).toEqual(["a", "c"]); // e is closed
    expect(await ids({ excludeConditionIds: ["b", "d"] })).toEqual(["c", "a"]);
  });
  it("sorts: vol24h, edge, endDate, priority", async () => {
    expect(await ids({ sort: "vol24h" })).toEqual(["d", "b", "a", "c"]);
    expect(await ids({ sort: "edge" })).toEqual(["b", "a", "c", "d"]);
    expect(await ids({ sort: "endDate" })).toEqual(["a", "b", "c", "d"]);
    expect(await ids({ sort: "priority" })).toEqual(["b", "c", "a", "d"]);
  });
  it("limit", async () => expect(await ids({ sort: "vol24h", limit: 2 })).toEqual(["d", "b"]));
  it("skipIfResearchedWithinHours: recent non-failed pods skip; failed or old do not; 0 disables", async () => {
    await db.insert(s.pods).values([
      { id: "p1", conditionId: "b", startedAt: new Date(NOW - 2 * 3_600_000), status: "done", trigger: "t" },
      { id: "p2", conditionId: "c", startedAt: new Date(NOW - 2 * 3_600_000), status: "failed", trigger: "t" },
      { id: "p3", conditionId: "a", startedAt: new Date(NOW - 30 * 3_600_000), status: "done", trigger: "t" },
    ]);
    expect(await ids({})).toEqual(["c", "a", "d"]);
    expect(await ids({ skipIfResearchedWithinHours: 1 })).toEqual(["b", "c", "a", "d"]);
    expect(await ids({ skipIfResearchedWithinHours: 0 })).toEqual(["b", "c", "a", "d"]);
    expect(await ids({ skipIfResearchedWithinHours: 48 })).toEqual(["c", "d"]);
  });
  it("returns spread and latest edge", async () => {
    const r = (await j.matchMarkets(db, F({ includeConditionIds: ["a"], skipIfResearchedWithinHours: 0 }), NOW))[0]!;
    expect(r).toMatchObject({ conditionId: "a", vol24h: 1000, edgeC: 0.05 });
    expect(r.spread).toBeCloseTo(0.02);
  });
});

describe("profile routes", () => {
  let list: typeof import("./profiles/route"), one: typeof import("./profiles/[id]/route"), prev: typeof import("./profiles/preview/route"), models: typeof import("./models/route");
  beforeAll(async () => {
    list = await import("./profiles/route");
    one = await import("./profiles/[id]/route");
    prev = await import("./profiles/preview/route");
    models = await import("./models/route");
  });
  it("create with defaults, get, list, update, delete", async () => {
    const c = await list.POST(req("POST", { name: "P1" }));
    expect(c.status).toBe(201);
    const p = await c.json();
    expect(p).toMatchObject({ name: "P1", enabled: false, everyMin: null, steering: DEFAULT_STEERING, filter: { limit: 10, sort: "priority" } });
    expect((await one.GET(req("GET"), ctx(p.id))).status).toBe(200);
    expect((await (await list.GET()).json()).map((x: any) => x.name)).toContain("P1");
    const u = await one.PUT(req("PUT", { name: "P1b", enabled: true, everyMin: 60, steering: { roles: ["rules"], question: "q" } }), ctx(p.id));
    expect(await u.json()).toMatchObject({ name: "P1b", enabled: true, everyMin: 60, steering: { roles: ["rules"], question: "q" } });
    expect((await one.DELETE(req("DELETE"), ctx(p.id))).status).toBe(200);
    expect((await one.GET(req("GET"), ctx(p.id))).status).toBe(404);
    expect((await one.DELETE(req("DELETE"), ctx(p.id))).status).toBe(404);
    expect((await one.PUT(req("PUT", { name: "z" }), ctx(p.id))).status).toBe(404);
  });
  it("400 on bad bodies", async () => {
    for (const body of [undefined, {}, { name: "" }, { name: "x", bogus: 1 }, { name: "x", steering: { roles: ["nope"] } }, { name: "x", steering: { roles: [] } }, { name: "x", steering: { ...DEFAULT_STEERING, models: { judge: "gpt-5" } } }, { name: "x", filter: { limit: 99 } }, { name: "x", everyMin: 0 }])
      expect((await list.POST(req("POST", body))).status, JSON.stringify(body)).toBe(400);
    expect((await one.PUT(req("PUT", { name: "x", enabled: "yes" }), ctx("nope"))).status).toBe(400);
    expect((await prev.POST(req("POST", { filter: { limit: 0 } }))).status).toBe(400);
    expect((await prev.POST(req("POST", {}))).status).toBe(400);
  });
  it("409 on duplicate name", async () => {
    expect((await list.POST(req("POST", { name: "dup" }))).status).toBe(201);
    expect((await list.POST(req("POST", { name: "dup" }))).status).toBe(409);
    const o = await (await list.POST(req("POST", { name: "other" }))).json();
    expect((await one.PUT(req("PUT", { name: "dup" }), ctx(o.id))).status).toBe(409);
    expect((await one.PUT(req("PUT", { name: "other", enabled: true }), ctx(o.id))).status).toBe(200); // own name is fine
  });
  it("preview and models", async () => {
    const r = await prev.POST(req("POST", { filter: { categories: ["crypto"], skipIfResearchedWithinHours: 0 } }));
    expect(r.status).toBe(200);
    expect((await r.json()).map((m: any) => m.conditionId)).toEqual(["b"]);
    expect(await models.GET().json()).toMatchObject({ models: expect.arrayContaining(["claude-opus-5-5"]), roles: ["rules", "source", "base_rate", "news", "red_team"] });
  });
});

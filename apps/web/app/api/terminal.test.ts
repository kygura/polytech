import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY;

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (f: () => unknown) => void f() }));

const U = "http://x/api";
const get = (p: string, init?: RequestInit) => new Request(U + p, init);
const body = (method: string, b: unknown) => new Request(U, { method, body: JSON.stringify(b) });
let NOW = 0; // PM_FIXTURES pins the app clock, so seed relative to it
const H = 3_600_000;
const ids = { a: "0xa", b: "0xb", c: "0xc", d: "0xd", closed: "0xz" };

let h: Record<string, any>, db: any, S: any;
const q = async (qs: string) => {
  const r = await h.markets.GET(get("/markets?" + qs));
  return { status: r.status, body: await r.json() };
};
const keys = async (qs: string) => (await q(qs)).body.rows?.map((r: any) => r.conditionId);

beforeAll(async () => {
  const a = await import("../../lib/api"), db_ = await import("@pm/db");
  S = db_.schema;
  NOW = (await a.getRead()).now();
  db = (await a.getDeps()).db;
  const m = (id: string, o: object) => ({ conditionId: id, question: `Will ${id} happen? Bitcoin`, rules: "rules text", category: "politics", tags: ["election"], endDate: new Date(NOW + 30 * 864e5), liquidity: 10_000, vol24h: 1000, resolutionSource: "official_data", ...o });
  await db.insert(S.markets).values([
    m(ids.a, { liquidity: 3000, tags: ["Election", "us"] }),
    m(ids.b, { liquidity: 20_000, category: "sports", tags: ["nba"], resolutionSource: "subjective", question: "Lakers title?" }),
    m(ids.c, { liquidity: 60_000, tags: [], resolutionSource: null }),
    m(ids.d, { liquidity: 8000, category: null, tags: ["misc"] }),
    m(ids.closed, { status: "closed" }),
  ]);
  const l = (id: string, o: object) => ({ conditionId: id, ts: new Date(NOW), mid: 0.4, spread: 0.02, depth2c: 500, priority: 0.5, lastTradeTs: new Date(NOW - 5 * H), ...o });
  await db.insert(S.marketLatest).values([
    l(ids.a, { priority: 0.9, opportunity: { side: "YES", edge: 0.05, stake: 10, o: 0.02, contrarian: false } }),
    l(ids.b, { priority: 0.7, structural: ["overround"], lastTradeTs: new Date(NOW - 100 * H) }),
    l(ids.c, { priority: null, depth2c: 5000 }),
    // d has no market_latest row at all
  ]);
  await db.insert(S.marketFlags).values([{ conditionId: ids.b, pinned: true }, { conditionId: ids.c, muted: true }]);
  const th = (id: string, cid: string, createdAt: Date, o: object = {}) => ({ id, conditionId: cid, podId: "p", pHat: 0.6, c: 0.4, pPost: 0.5, side: "YES", edgeC: 3, sizeUsd: 10, createdAt, expiresAt: new Date(NOW + 5 * 864e5), ...o });
  await db.insert(S.theses).values([
    th("t-a-old", ids.a, new Date(NOW - 3 * 864e5), { side: "NO", edgeC: 1 }),
    th("t-a-new", ids.a, new Date(NOW - 1 * 864e5), { edgeC: 4 }),
    th("t-d", ids.d, new Date(NOW - 864e5), { expiresAt: new Date(NOW - H) }), // expired
  ]);
  h = {
    markets: await import("./markets/route"),
    views: await import("./views/route"),
    alerts: await import("./alerts/route"),
    ack: await import("./alerts/[id]/ack/route"),
    ackAll: await import("./alerts/ack-all/route"),
    journal: await import("./journal/route"),
    status: await import("./status/route"),
    bus: await import("../../lib/jobs/events"),
    proxy: await import("../../proxy"),
  };
}, 60_000);

describe("GET /api/markets", () => {
  it("default: active only, priority desc nulls last, total + canonical query", async () => {
    const { status, body } = await q("");
    expect(status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.rows.map((r: any) => r.conditionId)).toEqual([ids.a, ids.b, ids.c, ids.d].slice(0, 2).concat([ids.c, ids.d].sort())); // c, d have null priority: id tiebreak
    expect(body.query).toBe("");
    const a = body.rows[0];
    expect(a).toMatchObject({ question: expect.any(String), category: "politics", liquidity: 3000, vol24h: 1000, pinned: false, muted: false, priority: 0.9, thesis: { id: "t-a-new", side: "YES", edgeC: 4, pPost: 0.5, expired: false } });
    expect(a.opportunity.o).toBe(0.02);
    expect(body.rows.find((r: any) => r.conditionId === ids.d).mid).toBeNull(); // left join: no market_latest row
  });

  it("ranges, tags (case-insens.), categories, src, struct, text", async () => {
    expect(await keys("q=" + encodeURIComponent("liq:5k..50k"))).toEqual([ids.b, ids.d]);
    expect(await keys("q=tag:election")).toEqual([ids.a]);
    expect(await keys("q=tag:-election")).toEqual([ids.b, ids.c, ids.d]);
    expect(await keys("q=cat:politics")).toEqual([ids.a, ids.c]);
    expect(await keys("q=cat:-politics")).toEqual([ids.b, ids.d]); // null category is not "politics"
    expect(await keys("q=src:subjective")).toEqual([ids.b]);
    expect(await keys("q=struct:overround")).toEqual([ids.b]);
    expect(await keys("q=lakers")).toEqual([ids.b]);
    expect(await keys("q=" + encodeURIComponent("100%"))).toEqual([]); // no LIKE wildcards
    expect(await keys("q=depth:>1k")).toEqual([ids.c]);
    expect(await keys("q=stale:>48")).toEqual([ids.b]);
    expect(await keys("q=days:<40")).toHaveLength(4);
    expect(await keys("q=opp:>0.01")).toEqual([ids.a]);
    expect(await keys("q=edge:>3%")).toEqual([ids.a]);
  });

  it("is:watch (pinned or live thesis), pinned, muted, has:thesis", async () => {
    expect(await keys("q=is:watch")).toEqual([ids.a, ids.b]); // d's thesis expired
    expect(await keys("q=is:pinned")).toEqual([ids.b]);
    expect(await keys("q=is:muted")).toEqual([ids.c]);
    expect(await keys("q=-is:muted")).toEqual([ids.a, ids.b, ids.d]);
    expect(await keys("q=has:thesis")).toEqual([ids.a, ids.d]);
    expect(await keys("q=-has:thesis")).toEqual([ids.b, ids.c]);
    expect((await q("q=has:thesis")).body.total).toBe(2); // one thesis row per market, not per thesis
  });

  it("sort (nulls last), limit/offset, total independent of paging", async () => {
    expect(await keys("q=sort:-liq")).toEqual([ids.c, ids.b, ids.d, ids.a]);
    expect(await keys("q=sort:depth")).toEqual([ids.a, ids.b, ids.c, ids.d]); // asc, d (null) last
    const p = await q("q=sort:-liq&limit=2&offset=1");
    expect(p.body.rows.map((r: any) => r.conditionId)).toEqual([ids.b, ids.d]);
    expect(p.body.total).toBe(4);
    expect((await q("q=limit:1")).body.rows).toHaveLength(1);
    expect((await q("q=limit:1&limit=3")).body.rows).toHaveLength(3); // URL params win
  });

  it("filter=<json>", async () => {
    expect(await keys("filter=" + encodeURIComponent(JSON.stringify({ liquidity: { min: 15_000 }, sort: [{ field: "liquidity", dir: "asc" }] })))).toEqual([ids.b, ids.c]);
    expect((await q("filter=" + encodeURIComponent('{"liquidity":{"min":"x"}}'))).status).toBe(400);
    expect((await q("filter=not-json")).status).toBe(400);
    expect((await q("q=a&filter={}")).status).toBe(400);
  });

  it("DSL errors -> 400 with col and suggestion; bad paging -> 400", async () => {
    const r = await q("q=" + encodeURIComponent("liq:5k liqq:3"));
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ token: "liqq:3", col: 7, suggestion: expect.any(String) });
    expect((await q("limit=5000")).status).toBe(400);
    expect((await q("offset=-1")).status).toBe(400);
  });

  it("injection attempt is just text", async () => {
    const r = await q("q=" + encodeURIComponent(`"'); drop table markets; --"`));
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
    expect((await q("")).body.total).toBe(4);
  });
});

describe("/api/views", () => {
  it("upsert by name, list, delete, validation", async () => {
    const v1 = await (await h.views.POST(body("POST", { name: "Cheap", query: "liq:<5k sort:-prio", columns: ["question", "liq"] }))).json();
    expect(v1).toMatchObject({ name: "Cheap", query: "liq:<5k sort:-prio", columns: ["question", "liq"] });
    const v2 = await (await h.views.POST(body("POST", { name: "Cheap", query: "liq:<9k", columns: [] }))).json();
    expect(v2.id).toBe(v1.id); // same name => update
    const list = await (await h.views.GET()).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ query: "liq:<9k", columns: [] });

    const bad = await h.views.POST(body("POST", { name: "Bad", query: "nope:1", columns: [] }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0].token).toBe("nope:1");
    expect((await h.views.POST(body("POST", { name: "", query: "", columns: [] }))).status).toBe(400);
    expect((await h.views.POST(body("POST", { name: "x", query: "", columns: [], extra: 1 }))).status).toBe(400);

    expect((await h.views.DELETE(new Request(U + "/views?id=nope", { method: "DELETE" }))).status).toBe(404);
    expect((await h.views.DELETE(new Request(U + "/views", { method: "DELETE" }))).status).toBe(400);
    expect((await h.views.DELETE(new Request(U + `/views?id=${v1.id}`, { method: "DELETE" }))).status).toBe(200);
    expect(await (await h.views.GET()).json()).toEqual([]);
  });
});

describe("/api/alerts", () => {
  it("list, unacked filter, ack one (+event), ack-all", async () => {
    await db.insert(S.alerts).values([
      { conditionId: ids.a, kind: "mid_move", message: "moved", createdAt: new Date(NOW - 3 * H) },
      { conditionId: null, kind: "run_failed", message: "boom", createdAt: new Date(NOW - 2 * H) },
      { conditionId: ids.b, kind: "structural", message: "arb", createdAt: new Date(NOW - H) },
    ]);
    const all = await (await h.alerts.GET(get("/alerts?unacked=1&limit=2"))).json();
    expect(all.unacked).toBe(3);
    expect(all.rows.map((r: any) => r.kind)).toEqual(["structural", "run_failed"]); // newest first, limited
    expect(all.rows[0].question).toBe("Lakers title?");
    expect(all.rows[1].question).toBeNull();

    const events: any[] = [];
    const off = h.bus.subscribe((e: any) => events.push(e));
    const id = all.rows[0].id;
    expect((await h.ack.POST(new Request(U), { params: Promise.resolve({ id: String(id) }) })).status).toBe(200);
    expect(events).toMatchObject([{ type: "alert.acked", payload: { ids: [id], all: false } }]);
    expect((await h.ack.POST(new Request(U), { params: Promise.resolve({ id: String(id) }) })).status).toBe(404); // already acked
    expect((await h.ack.POST(new Request(U), { params: Promise.resolve({ id: "abc" }) })).status).toBe(400);
    const un = await (await h.alerts.GET(get("/alerts?unacked=1"))).json();
    expect(un.rows).toHaveLength(2);
    expect((await (await h.alerts.GET(get("/alerts"))).json()).rows).toHaveLength(3);

    expect(await (await h.ackAll.POST()).json()).toEqual({ acked: 2 });
    expect(events.at(-1)).toMatchObject({ type: "alert.acked", payload: { all: true } });
    expect((await (await h.alerts.GET(get("/alerts?unacked=1"))).json())).toMatchObject({ rows: [], unacked: 0 });
    expect(await (await h.ackAll.POST()).json()).toEqual({ acked: 0 });
    off();
    expect((await h.alerts.GET(get("/alerts?limit=0"))).status).toBe(400);
  });
});

describe("GET /api/journal", () => {
  it("summary, recent rows, reliability bins, suggested; filters", async () => {
    const jr = (id: string, cid: string, o: object) => ({ thesisId: id, conditionId: cid, category: "politics", model: "m1", pHat: 0.7, pPre: 0.6, midAt: 0.5, liquidityAt: 3000, r: 0.5, side: "YES", stake: 10, result: "YES", resolvedAt: new Date(NOW), brierModel: 0.09, brierMarket: 0.25, brierPre: 0.16, logLoss: 0.35, paperPnl: 5, ...o });
    await db.insert(S.journal).values([
      jr("t-a-new", ids.a, {}),
      jr("t-a-old", ids.a, { category: "sports", model: "m2", result: null, resolvedAt: null, brierModel: null, brierMarket: null, paperPnl: null }),
      jr("t-d", ids.d, { result: "NO", paperPnl: -10, brierModel: 0.49, brierMarket: 0.25 }),
    ]);
    const b = await (await h.journal.GET(get("/journal"))).json();
    expect(b.summary).toMatchObject({ n: 3, resolved: 2, paperPnl: -5 });
    expect(b.summary.byCategory.map((x: any) => x.key).sort()).toEqual(["politics", "sports"]);
    expect(b.rows).toHaveLength(3);
    expect(b.rows[0].thesisId).toBe("t-a-new"); // newest thesis first
    expect(Array.isArray(b.bins)).toBe(true);
    expect(b).toHaveProperty("suggested", null);

    expect((await (await h.journal.GET(get("/journal?category=sports"))).json()).rows.map((r: any) => r.thesisId)).toEqual(["t-a-old"]);
    expect((await (await h.journal.GET(get("/journal?model=m1"))).json()).summary.n).toBe(2);
    expect((await (await h.journal.GET(get("/journal?days=2"))).json()).summary.n).toBe(2); // t-a-old is 3 days old
    expect((await h.journal.GET(get("/journal?days=-1"))).status).toBe(400);
  });
});

describe("GET /api/status", () => {
  it("cheap counters", async () => {
    await db.insert(S.pods).values([{ id: "pod1", conditionId: ids.a, trigger: "manual", status: "running" }, { id: "pod2", conditionId: ids.b, trigger: "manual", status: "done" }]);
    await db.insert(S.spend).values({ day: new Date(NOW).toISOString().slice(0, 10), anthropicUsd: 1.5 });
    await db.insert(S.alerts).values({ kind: "mid_move", message: "x" });
    const r = await (await h.status.GET()).json();
    expect(r).toEqual({ activeRuns: [{ id: "pod1", stage: null, question: expect.any(String) }], activeRunCount: 1, spendToday: { usd: 1.5, capUsd: 50 }, lastSnapshotAt: NOW, lastSweepAt: null, unackedAlerts: 1, mode: "L0" });
  });
});

describe("no login", () => {
  const via = async (path: string) => (await h.proxy.proxy(new (await import("next/server")).NextRequest(`http://x${path}`))).status;
  it("proxy: no login, every route open", async () => {
    for (const p of ["/api/markets", "/api/views", "/api/alerts", "/api/journal", "/api/status", "/api/pods/pod_x", "/api/markets/0xabc/history"]) expect(await via(p), p).toBe(200);
  });
});

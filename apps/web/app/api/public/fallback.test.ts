import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY;

const after = vi.fn(); // no request scope in tests; the kick is covered in public.test.ts
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (f: unknown) => after(f) }));

// Fresh database: markets + market_latest filled by the sweep/snapshot, no screens or theses yet.
let NOW = 0, wl: typeof import("./watchlist/route"), read: typeof import("../../../lib/jobs").read, r: any;
beforeAll(async () => {
  const a = await import("../../../lib/api"), { schema: S } = await import("@pm/db");
  r = await a.getRead();
  NOW = r.now();
  const db = r.db, day = 864e5;
  const m = (id: string, o: object = {}) => ({ conditionId: id, question: `Q ${id}?`, category: "politics", endDate: new Date(NOW + 30 * day), liquidity: 10_000, vol24h: 1000, ...o });
  await db.insert(S.markets).values([
    m("0xa"), m("0xpin"), m("0xb", { vol24h: 5000 }), m("0xc", { liquidity: 50_000 }), m("0xc2", { liquidity: 60_000 }),
    m("0xnomid"), m("0xpast", { endDate: new Date(NOW - day) }), m("0xnoend", { endDate: null }), m("0xclosed", { status: "closed" }), m("0xmuted"), m("0xnolatest"),
  ]);
  const l = (id: string, o: object = {}) => ({ conditionId: id, ts: new Date(NOW), mid: 0.4, priority: null, ...o });
  await db.insert(S.marketLatest).values([
    l("0xa", { priority: 0.9, mid: 0.3 }), l("0xpin", { priority: 0.5 }), l("0xb"), l("0xc"), l("0xc2"),
    l("0xnomid", { mid: null, priority: 1 }), l("0xpast", { priority: 1 }), l("0xnoend", { priority: 1 }), l("0xclosed", { priority: 1 }), l("0xmuted", { priority: 1 }),
  ]);
  await db.insert(S.marketFlags).values([{ conditionId: "0xpin", pinned: true }, { conditionId: "0xmuted", muted: true }]);
  read = (await import("../../../lib/jobs")).read;
  wl = await import("./watchlist/route");
}, 60_000);

describe("watchlist fallback (no screens/theses)", () => {
  it("read.topMarkets: open markets with a mid and a future end date, priority then volume then liquidity", async () => {
    const rows = await read.topMarkets(r);
    expect(rows.map((x) => x.conditionId)).toEqual(["0xa", "0xpin", "0xb", "0xc2", "0xc"]);
    expect(rows[0]).toMatchObject({ question: "Q 0xa?", category: "politics", tier: null, priority: 0.9, midNow: 0.3, shortlisted: false, thesisId: null, side: null, edgeC: null, rank: null, structural: null });
    expect(rows[0]!.daysLeft).toBeCloseTo(30);
    expect(rows[1]!.pinned).toBe(true);
    expect((await read.topMarkets(r, 2)).length).toBe(2);
    expect(await read.watchlist(r, "small-cap")).toEqual([]); // the screen-based list itself stays empty
  });

  it("public watchlist serves the fallback rows in the terminal row shape", async () => {
    const res = await wl.GET(new Request("http://x/api/public/watchlist", { headers: { "x-forwarded-for": "4.4.4.4" } }));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.rows.map((x: { conditionId: string }) => x.conditionId)).toEqual(["0xa", "0xpin", "0xb", "0xc2", "0xc"]);
    expect(b.rows[0]).toMatchObject({ conditionId: "0xa", midNow: 0.3, thesisId: null, side: null, pPost: null, edgeC: null, structural: null, research: "pending" });
    expect("pinned" in b.rows[1]).toBe(false); // still the public projection
  });
});

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY; // fake runner + judge

const after = vi.fn();
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (f: unknown) => after(f) }));

const cid = (k: string) => "0x" + createHash("sha256").update("cond:" + k).digest("hex");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string, ip = "9.9.9.9") => new Request(`http://x/api/public${path}`, { headers: { "x-forwarded-for": ip } });

let wl: typeof import("./watchlist/route"), mk: typeof import("./markets/[id]/route"), fd: typeof import("./markets/[id]/feed/route");
beforeAll(async () => {
  const j = await import("../../../lib/jobs"), a = await import("../../../lib/api");
  const d = await a.getDeps();
  await j.sweepUniverse(d);
  await j.snapshotBooks(d, "all");
  await j.screenAll(d);
  await j.researchShortlist(d, { limit: 3 });
  wl = await import("./watchlist/route");
  mk = await import("./markets/[id]/route");
  fd = await import("./markets/[id]/feed/route");
}, 120_000);

const deepKeys = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => deepKeys(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) out.add(k), deepKeys(v, out);
  return out;
};
const FORBIDDEN = ["pinned", "muted", "sizeUsd", "shares", "expectedProfit", "rank", "positions", "pod", "podId", "usage", "costUsd", "model", "durationS", "trigger", "roleMix", "judgeConfidence"];
const noForbidden = (x: unknown) => expect([...deepKeys(x)].filter((k) => FORBIDDEN.includes(k))).toEqual([]);

describe("public api", () => {
  it("watchlist: envelope with freshness + research status, projected rows, cache headers, kick via after()", async () => {
    const r = await wl.GET(get("/watchlist"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const b = await r.json();
    expect(b).toMatchObject({ research: "on", snapshotAt: expect.any(Number), stale: expect.any(Boolean) });
    expect("sweptAt" in b).toBe(true);
    noForbidden(b);
    expect(b.rows.filter((x: { research: string }) => x.research === "done").length).toBeGreaterThan(0);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("market detail: projected, carries sizing inputs; unknown id 404", async () => {
    const { rows } = await (await wl.GET(get("/watchlist"))).json(), id = rows.find((x: { thesisId?: string }) => x.thesisId)?.conditionId ?? cid("a1");
    const r = await mk.GET(get(`/markets/${id}`), ctx(id));
    expect(r.status).toBe(200);
    const b = await r.json();
    noForbidden(b);
    expect(b.research).toBe("done");
    expect(b.market).toMatchObject({ conditionId: id, feeRate: expect.any(Number), negRisk: expect.any(Boolean) });
    expect(b.snapshot).toMatchObject({ bids: expect.any(Array), asks: expect.any(Array), mid: expect.any(Number) });
    expect((await mk.GET(get("/markets/0xnope"), ctx("0xnope"))).status).toBe(404);
  });

  it("429 after 60/min from one IP", async () => {
    for (let i = 0; i < 60; i++) await mk.GET(get("/markets/0xnope", "7.7.7.7"), ctx("0xnope"));
    const r = await mk.GET(get("/markets/0xnope", "7.7.7.7"), ctx("0xnope"));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });
});

describe("public feed", () => {
  it("book, mid, last, tape, tick; short CDN cache; unknown id 404; per-IP limit", async () => {
    const { MarketFeedSchema } = await import("../../../lib/feed");
    const db = (await (await import("../../../lib/api")).getDeps()).db, { schema: s } = await import("@pm/db");
    const rows = await db.select({ id: s.markets.conditionId, tick: s.markets.tickSize }).from(s.markets);
    for (const tick of [0.01, 0.001]) {
      const row = rows.find((x) => x.tick === tick);
      expect(row, `fixture market with tick ${tick}`).toBeDefined();
      const r = await fd.GET(get(`/markets/${row!.id}/feed`, "5.5.5.5"), ctx(row!.id));
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("public, s-maxage=2, stale-while-revalidate=4");
      const b = MarketFeedSchema.parse(await r.json());
      expect(b.tickSize).toBe(tick);
      expect(b.bids.length).toBeGreaterThan(0);
      expect(b.mid).toBeGreaterThan(0);
      expect(JSON.stringify(b)).not.toMatch(/0x[0-9a-f]{40}/); // no wallets / tx hashes on the tape
    }
    expect((await fd.GET(get("/markets/0xnope/feed", "5.5.5.5"), ctx("0xnope"))).status).toBe(404);
    for (let i = 0; i < 120; i++) expect((await fd.GET(get("/markets/0xnope/feed", "6.6.6.6"), ctx("0xnope"))).status).toBe(404); // own 120/min bucket
    const r429 = await fd.GET(get("/markets/0xnope/feed", "6.6.6.6"), ctx("0xnope"));
    expect(r429.status).toBe(429);
    expect(r429.headers.get("retry-after")).toBe("60");
    expect((await mk.GET(get("/markets/0xnope", "6.6.6.6"), ctx("0xnope"))).status).toBe(404); // other public routes keep their own bucket
  });
});

describe("public projection", () => {
  it("evidence urls: only http(s) survive", async () => {
    const { safeUrl } = await import("../../../lib/public");
    expect(safeUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrl("HTTP://a.example")).toBe("HTTP://a.example");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,x")).toBe("");
  });
});

import { memoryKv, schema as s } from "@pm/db";
import { createPm, type Trade } from "@pm/pm";
import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { deps, latestSnaps, takeSnapshots, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

// 250 synthetic markets (> the 200-market crowd cap) behind a stub CLOB / Data API.
const N = 250;
const cond = (i: number) => `c${String(i).padStart(3, "0")}`, tok = (i: number) => `y${i}`;
let T = Date.parse("2026-10-15T12:00:00Z");
let oiScale = 1;
const tradeCalls: { market: string[]; since: number | undefined }[] = [];
const book = (token: string) => ({ token_id: token, bids: [{ price: 0.4, size: 1000 }], asks: [{ price: 0.42, size: 1000 }] });
const row = (c: string, ageMin: number, usd = 10): Trade => ({ condition_id: c, token_id: `y${Number(c.slice(1))}`, side: "BUY", size: usd / 0.4, price: 0.4, ts: Math.floor((T - ageMin * 60_000) / 1000) });
const base = createPm({ fixtures: true });
const pm = {
  ...base,
  books: async (tokens: string[]) => tokens.map(book),
  oi: async (cs: string[]) => Object.fromEntries(cs.map((c) => [c, 50_000 * oiScale])),
  holders: async () => [],
  trades: async (o: { market?: string[]; limit?: number; since?: number }) => {
    tradeCalls.push({ market: o.market!, since: o.since });
    const out: Trade[] = [];
    for (const c of o.market!) {
      if (c === "c000") for (let i = 0; i < 1000; i++) out.push(row(c, i * 0.5)); // a very busy market: more rows than one call may return
      else out.push(row(c, 30, 20), row(c, 90, 5));
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, o.limit);
  },
} as unknown as typeof base;
let d: Deps;
const snap = async () => { T += 5 * 60_000; return takeSnapshots({ ...d, now: () => T, pm }, Array.from({ length: N }, (_, i) => cond(i))); };
const ml = async (c: string) => (await d.db.select().from(s.marketLatest).where(eq(s.marketLatest.conditionId, c)))[0]!;

beforeAll(async () => {
  d = await deps({ pm, kv: memoryKv(), now: () => T });
  await d.db.insert(s.markets).values(Array.from({ length: N }, (_, i) => ({ conditionId: cond(i), question: `Q${i}?`, status: "active", yesTokenId: tok(i), noTokenId: `n${i}`, liquidity: 1000 + i, endDate: new Date(T + 30 * 864e5) })));
}, 60_000);

describe("crowd fetch beyond the cap", () => {
  it("a market outside the run's set is flow-unknown only until it has been fetched once; rotation reaches every market; later it keeps its last trade without the unknown flag", async () => {
    await snap();
    const unfetched = (await d.db.select().from(s.marketLatest)).filter((r) => r.flow24h == null).map((r) => r.conditionId);
    expect(unfetched.length).toBe(N - 200);
    const h = (await latestSnaps(d.db, unfetched)).get(unfetched[0]!)!;
    expect(h.book?.flowUnknown).toBe(true);
    await snap(); // the rotation picks the never-fetched ones first
    expect((await d.db.select().from(s.marketLatest)).filter((r) => r.flow24h == null && r.conditionId !== "c000")).toHaveLength(0); // c000 is the deliberately busy one
    await snap();
    // pick a market this run did not fetch: its history row (forced by a changed signature) must not be flagged unknown, and its last trade survives
    const fetchedNow = new Set(tradeCalls.slice(-50).flatMap((c) => c.market));
    const quiet = (await d.db.select().from(s.marketLatest)).find((r) => !fetchedNow.has(r.conditionId) && r.conditionId !== "c000")!;
    expect(quiet.lastTradeTs).not.toBeNull();
    oiScale = 3; // changes every history row's signature
    await snap();
    const row2 = (await latestSnaps(d.db, [quiet.conditionId])).get(quiet.conditionId)!;
    expect(row2.book?.flowUnknown).toBeUndefined();
    expect(row2.lastTradeTs).not.toBeNull();
    oiScale = 1;
  });

  it("trades are fetched since 24h ago in small chunks; a busy market cannot crowd a quiet one out; its own incomplete window yields no flow number", async () => {
    tradeCalls.length = 0;
    await snap();
    expect(tradeCalls.length).toBeGreaterThan(0);
    for (const c of tradeCalls) {
      expect(c.since).toBe(Math.floor((T - 24 * 3_600_000) / 1000));
      expect(c.market.length).toBeLessThanOrEqual(5);
    }
    const quiet = await ml("c001");
    expect(quiet.flow24h).toBeCloseTo(25, 6); // 20 + 5 USD of buys, not zeroed by the busy neighbour
    expect(quiet.largeTrade24h).toBe(false);
    const busy = await ml("c000");
    const st = (await latestSnaps(d.db, ["c000"])).get("c000")!;
    expect(busy.flow24h).toBeNull(); // 1000 rows hit the cap before 24h: no number rather than a truncated one
    expect(st.book?.flowUnknown).toBe(true);
  });
});

describe("history row change test", () => {
  it("includes oi / flow / volume signals, not only the book", async () => {
    await snap();
    const n0 = (await d.db.select({ n: count() }).from(s.snapshots))[0]!.n;
    const same = await snap();
    expect(same.snapshots).toBeLessThan(5); // nothing but the busy-market noise changed
    oiScale = 2;
    const moved = await snap();
    expect(moved.snapshots).toBeGreaterThan(N - 5); // same books, new oi: every history row is re-recorded
    expect((await d.db.select({ n: count() }).from(s.snapshots))[0]!.n).toBeGreaterThan(n0);
    oiScale = 1;
  });
});

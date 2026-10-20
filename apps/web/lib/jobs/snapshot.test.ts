import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, type Book } from "@pm/pm";
import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { deps, latestSnaps, snapshotBooks, sweepUniverse, takeSnapshots, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

const fx = createPm({ fixtures: true });
let T = Date.parse("2026-10-15T12:00:00Z");
/** token -> book edit, applied to what the CLOB "serves" */
const tweak = new Map<string, (b: Book) => Book>();
const pm = { ...fx, books: async (tokens: string[]) => (await fx.books(tokens)).map((b) => tweak.get(b.token_id)?.(b) ?? b) } as typeof fx;
let d: Deps, yes: Map<string, string>;
// scoped to explicit ids: a full run also prunes history of unwatched markets, which would hide the row counts under test
const snap = async () => (await takeSnapshots({ ...d, now: () => T }, [...yes.keys()])) as { markets: number; snapshots: number; latest: number; unchanged: number; noBook: number };
const hist = async () => (await d.db.select({ n: count() }).from(s.snapshots))[0]!.n;
const ml = async (c: string) => (await d.db.select().from(s.marketLatest).where(eq(s.marketLatest.conditionId, c)))[0]!;

beforeAll(async () => {
  d = await deps({ pm, kv: memoryKv(), now: () => T, runner: fakeRunner, judge: fakeJudge });
  await sweepUniverse(d);
  yes = new Map((await d.db.select().from(s.markets)).map((m) => [m.conditionId, m.yesTokenId!]));
}, 60_000);

describe("snapshot: market_latest in place, history only on change", () => {
  it("first run: every market with a book gets a history row and a market_latest row with book metrics and crowd fields", async () => {
    const out = await snap();
    expect(out.latest).toBeGreaterThan(20);
    expect(out.snapshots).toBe(out.latest);
    expect(await hist()).toBe(out.latest);
    const rows = await d.db.select().from(s.marketLatest);
    expect(rows).toHaveLength(out.latest);
    expect(rows.every((r) => r.mid != null && r.bestBid != null && r.spread != null && r.depth2c != null && r.exitDepth != null && r.bookHash && r.midChangedAt)).toBe(true);
    expect(rows.filter((r) => r.holderCount != null && r.top1Share != null && r.holderHhi != null).length).toBeGreaterThan(0); // fixtures hold holders for some markets
    expect(rows.every((r) => r.flow24h != null && r.lastTradeTs !== undefined)).toBe(true); // all fixture markets are crowd candidates (< 200)
  });

  it("stored book keeps only levels within 10c of the touch; market_latest depth still comes from the full book", async () => {
    const [c, tok] = [...yes][0]!;
    const far = (n: number, from: number, dir: number) => Array.from({ length: n }, (_, k) => ({ price: +(from + dir * k * 0.01).toFixed(2), size: 100 }));
    tweak.set(tok, (b) => ({ ...b, bids: far(30, 0.4, -1), asks: far(30, 0.45, 1) }));
    T += 3_600_000;
    await snap();
    const row = (await latestSnaps(d.db, [c])).get(c)!;
    expect(row.book!.bids.every((l) => l.price >= 0.3 - 1e-9) && row.book!.asks.every((l) => l.price <= 0.55 + 1e-9)).toBe(true);
    expect(row.book!.bids).toHaveLength(11);
    expect((await ml(c)).depth5c).toBeGreaterThan(0);
    tweak.delete(tok);
    T += 3_600_000;
    await snap();
  });

  it("an identical run inserts no history, but market_latest.ts moves and latestSnaps reports the fresher age", async () => {
    const before = await hist(), c = [...yes.keys()][0]!, t0 = (await ml(c)).ts.getTime();
    T += 60_000;
    const out = await snap();
    expect(out.snapshots).toBe(0);
    expect(out.unchanged).toBe(out.latest);
    expect(await hist()).toBe(before);
    expect((await ml(c)).ts.getTime()).toBe(t0 + 60_000);
    expect((await latestSnaps(d.db, [c])).get(c)!.ts.getTime()).toBe(t0 + 60_000); // the unchanged book was last seen now
  });

  it("a changed book gets a history row; mid_changed_at bumps only when the mid moves >= 1c", async () => {
    const [a, b] = [...yes.keys()];
    const [ta, tb] = [yes.get(a!)!, yes.get(b!)!];
    const [ma0, mb0] = [await ml(a!), await ml(b!)];
    tweak.set(ta, (x) => ({ ...x, bids: x.bids.map((l, i) => (i === 0 ? { ...l, size: l.size + 7 } : l)) })); // size only
    tweak.set(tb, (x) => ({ ...x, bids: x.bids.map((l, i) => (i === 0 ? { ...l, price: Math.round((l.price + 0.02) * 100) / 100 } : l)) })); // mid +1c
    const before = await hist();
    T += 60_000;
    const out = await snap();
    expect(out.snapshots).toBe(2);
    expect(await hist()).toBe(before + 2);
    const [ma1, mb1] = [await ml(a!), await ml(b!)];
    expect(ma1.bookHash).not.toBe(ma0.bookHash);
    expect(ma1.midChangedAt).toEqual(ma0.midChangedAt); // same mid
    expect(mb1.mid! - mb0.mid!).toBeCloseTo(0.01, 6);
    expect(mb1.midChangedAt!.getTime()).toBe(T);
    tweak.clear();
  });

  it("an hour after the last history row, an unchanged book is recorded again", async () => {
    T += 61 * 60_000;
    const before = await hist();
    const out = await snap();
    expect(out.snapshots).toBe(out.latest);
    expect(await hist()).toBe(before + out.latest);
  });

  it("crowd endpoints failing keeps the previous crowd fields and marks the history row flowUnknown", async () => {
    const c = (await d.db.select().from(s.marketLatest)).find((r) => r.holderCount != null)!;
    const boom = async () => { throw new Error("GET /v2/holders -> 403 <html>"); };
    T += 61 * 60_000;
    const dd = { ...d, now: () => T, pm: { ...pm, holders: boom, trades: boom } as typeof pm };
    await takeSnapshots(dd, [...yes.keys()]);
    const after = await ml(c.conditionId);
    expect(after.holderCount).toBe(c.holderCount);
    expect(after.flow24h).toBe(c.flow24h);
    const newest = (await latestSnaps(d.db, [c.conditionId])).get(c.conditionId)!;
    expect(newest.book?.flowUnknown).toBe(true);
  });

  it("snapshotBooks(watchlist) runs the monitor at its tail and survives a monitor failure", async () => {
    T += 61 * 60_000;
    const out = await snapshotBooks({ ...d, now: () => T, kv: { ...d.kv, lock: async (k: string, ttl: number) => (k === "job:monitor" ? (() => { throw new Error("boom"); })() : d.kv.lock(k, ttl)) } as Deps["kv"] }, "watchlist");
    expect(out).toMatchObject({ markets: expect.any(Number) }); // the snapshot result is returned despite the monitor throwing
  });
});

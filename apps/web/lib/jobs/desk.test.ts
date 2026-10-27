import { fakeJudge, fakeRunner, type AgentRunner, type Triage } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { cancelPaperOrder, deps, latestSnaps, listPaperOrders, placePaperOrder, read, researchMarket, restingBuy, restingSell, sellFill, snapshotBooks, stopHit, sweepUniverse, triageMarkets, triageRules, workPaperOrders, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

let d: Deps, ok: string[];
const calls: string[] = [];
const triage: Triage = async (i) => (calls.push(i.question), { verdict: "research", score: 0.8, reason: "objective source", model: "test", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });

beforeAll(async () => {
  let t = Date.parse("2026-10-15T12:00:00Z");
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge, triage });
  await sweepUniverse(d); await snapshotBooks(d, "all");
  const all = (await d.db.select({ c: s.markets.conditionId }).from(s.markets).where(eq(s.markets.status, "active"))).map((r) => r.c);
  const snaps = await latestSnaps(d.db, all);
  ok = all.filter((c) => { const b = snaps.get(c); return b?.book?.asks.length && b.book.bids.length && b.mid != null && b.mid > 0.15 && b.mid < 0.85; }); // mid-range: the tests price limits 5-10c either side
}, 60_000);

describe("triage", () => {
  it("primitive rules name what fails, without a model", () => {
    const m = { status: "active", endDate: new Date(Date.parse("2026-10-15T12:00:00Z") + 3_600_000), category: "x" } as typeof s.markets.$inferSelect;
    const snap = { book: { bids: [], asks: [] }, mid: 0.99, bestBid: 0.5, bestAsk: 0.99, depth5cUsd: 10 } as unknown as typeof s.snapshots.$inferSelect;
    expect(triageRules(m, snap, d.settings, Date.parse("2026-10-15T12:00:00Z"))).toEqual(["ENDS_TOO_SOON", "PRICE_EXTREME", "WIDE_SPREAD", "THIN_BOOK"]);
    expect(triageRules(m, undefined, d.settings, 0)).toContain("NO_BOOK");
  });

  it("calls the model only for markets that pass the rules, stores verdicts and reuses them for a day", async () => {
    const ids = ok.slice(0, 6);
    const rows = await triageMarkets(d, ids);
    expect(rows.map((r) => r.conditionId).sort()).toEqual([...ids].sort());
    const ruled = rows.filter((r) => r.failedRules.length);
    expect(ruled.every((r) => r.verdict === "skip" && r.model === null)).toBe(true);
    expect(calls.length).toBe(rows.length - ruled.length);
    const n = calls.length;
    await triageMarkets(d, ids);
    expect(calls.length).toBe(n); // fresh: no new model calls
    await triageMarkets(d, ids, { force: true });
    expect(calls.length).toBe(2 * n);
  });

  it("a model failure marks that market, not the batch", async () => {
    const boom: Triage = async () => { throw new Error("overloaded"); };
    const rows = await triageMarkets({ ...d, triage: boom }, ok.slice(0, 2), { force: true });
    expect(rows.filter((r) => !r.failedRules.length).every((r) => r.verdict === "skip" && r.reason.startsWith("classifier error"))).toBe(true);
  });
});

describe("research desk read", () => {
  it("a failed pod carries its reason; a done pod carries progress and a verdict or the judge's fair value", async () => {
    const broken: AgentRunner = async () => { throw new Error("Native CLI binary for linux-x64 not found"); };
    const bad = await researchMarket({ ...d, runner: broken }, ok[0]!, "manual");
    if ("skipped" in bad) throw new Error(bad.reason);
    expect(bad.status).toBe("failed");
    const good = await researchMarket(d, ok[1]!, "manual");
    if ("skipped" in good) throw new Error(good.reason);
    const live = await read.researchLive(d, { ids: [ok[0]!, ok[1]!] });
    const f = live.runs.find((r) => r.podId === bad.podId)!, g = live.runs.find((r) => r.podId === good.podId)!;
    expect(f.status).toBe("failed");
    expect(f.error).toContain("Native CLI binary");
    expect(g.status).toBe("done");
    expect(g.agents).toEqual({ total: 5, done: 5, failed: 0 });
    expect(g.verdict ?? g.judge).not.toBeNull();
    expect(live.budget.maxRunning).toBe(d.settings.budget.maxConcurrentSandboxes);
  });
});

describe("paper orders", () => {
  // A newer book for one market, as the next snapshot run would write it.
  const nextBook = async (id: string, book: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }, mid?: number) => {
    const { id: _, ...snap } = (await latestSnaps(d.db, [id])).get(id)!;
    const ts = new Date(d.now() + 60_000);
    await d.db.insert(s.snapshots).values({ ...snap, ts, book: { ...snap.book!, ...book }, ...(mid != null ? { mid } : {}) });
    await d.db.update(s.marketLatest).set({ ts }).where(eq(s.marketLatest.conditionId, id));
  };
  const openPos = (tokenId: string) => d.db.select().from(s.positions).where(and(eq(s.positions.tokenId, tokenId), eq(s.positions.paper, true), isNull(s.positions.closedAt)));

  it("sellFill walks bids best first", () => {
    expect(sellFill([{ price: 0.4, size: 10 }, { price: 0.5, size: 5 }], 10)).toMatchObject({ shares: 10, avgPrice: 0.45, complete: true });
    expect(sellFill([{ price: 0.5, size: 5 }], 10)).toMatchObject({ shares: 5, complete: false });
  });

  it("BUY fills against the asks into one position, SELL reduces then closes it with realized P&L", async () => {
    const id = ok[2]!;
    const m = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, id)))[0]!;
    const buy = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5 });
    if (!buy.ok) throw new Error(buy.error);
    expect(buy.shares).toBeGreaterThan(0);
    const again = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5 });
    if (!again.ok) throw new Error(again.error);
    const [p] = await openPos(m.yesTokenId!);
    expect(await openPos(m.yesTokenId!)).toHaveLength(1);
    expect(p!.size).toBeCloseTo(buy.shares + again.shares, 6);
    const half = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "SELL", shares: p!.size / 2 });
    if (!half.ok) throw new Error(half.error);
    expect((await openPos(m.yesTokenId!))[0]!.size).toBeCloseTo(p!.size / 2, 6);
    const rest = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "SELL", shares: 1e9 });
    if (!rest.ok) throw new Error(rest.error);
    expect(await openPos(m.yesTokenId!)).toHaveLength(0);
    expect(typeof rest.realizedPnl).toBe("number");
    const orders = await d.db.select().from(s.orders).where(and(eq(s.orders.conditionId, id), eq(s.orders.thesisId, "manual")));
    expect(orders).toHaveLength(4);
    expect(orders.every((o) => o.paper && o.status === "paper_filled")).toBe(true);
    const book = await read.paperBook(d);
    expect(book.fills.filter((f) => f.conditionId === id).map((f) => [f.action, f.side, f.manual])).toEqual([["SELL", "YES", true], ["SELL", "YES", true], ["BUY", "YES", true], ["BUY", "YES", true]]);
  });

  it("refuses what it cannot fill: no position to sell, no amount, a stop on the wrong side or with a limit", async () => {
    const id = ok[3]!;
    expect(await placePaperOrder(d, { conditionId: id, outcome: "NO", side: "SELL", shares: 1 })).toEqual({ ok: false, error: "you hold no paper NO shares" });
    expect(await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY" })).toEqual({ ok: false, error: "enter an amount in dollars" });
    const r = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5, stop: 0.01 });
    expect(r.ok === false && r.error).toMatch(/^a buy stop must be above the price now/);
    expect(await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5, stop: 0.99, limit: 0.5 })).toEqual({ ok: false, error: "a stop order fills at market: leave the limit out" });
  });

  it("resting fills are maker fills at the limit; stops fire on the far side of the price", () => {
    const asks = [{ price: 0.4, size: 10 }, { price: 0.45, size: 10 }, { price: 0.5, size: 10 }];
    expect(restingBuy(asks, 100, 0.45)).toEqual({ shares: 20, avgPrice: 0.45, fee: 0, filled: 9 });
    expect(restingBuy(asks, 4.5, 0.45)).toMatchObject({ shares: 10, filled: 4.5 });
    expect(restingSell([{ price: 0.6, size: 5 }, { price: 0.5, size: 5 }], 8, 0.55)).toEqual({ shares: 5, avgPrice: 0.55, fee: 0 });
    expect([stopHit("BUY", 0.6, 0.59), stopHit("BUY", 0.6, 0.6), stopHit("SELL", 0.4, 0.41), stopHit("SELL", 0.4, 0.4)]).toEqual([false, true, false, true]);
  });

  it("a limit below the market rests, fills on a later book that reaches it, and can be cancelled", async () => {
    const id = ok[4]!;
    const snap = (await latestSnaps(d.db, [id])).get(id)!;
    const ask = Math.min(...snap.book!.asks.map((a) => a.price));
    const below = Math.round((ask - 0.05) * 100) / 100;
    const r = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5, limit: below });
    if (!r.ok) throw new Error(r.error);
    expect(r.shares).toBe(0);
    expect(r.working).toMatchObject({ kind: "limit", side: "BUY", limit: below, usd: 5 });
    // same book again: nothing new to fill against
    expect(await workPaperOrders(d, [id])).toMatchObject({ working: 1, filled: 0 });
    // the market drops through the limit: the next book fills it at the limit, maker, no fee
    const book = { bids: snap.book!.bids.map((b) => ({ ...b, price: Math.round((b.price - 0.1) * 100) / 100 })), asks: [{ price: below - 0.01, size: 1000 }] };
    await nextBook(id, book);
    expect(await workPaperOrders(d, [id])).toMatchObject({ filled: 1, working: 0 });
    const list = await listPaperOrders(d, id);
    expect(list.working).toHaveLength(0);
    expect(list.closed[0]).toMatchObject({ status: "filled", usd: 0 });
    expect(list.closed[0]!.filledShares).toBeCloseTo(5 / below, 6);
    const m = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, id)))[0]!;
    expect((await openPos(m.yesTokenId!))[0]!.avgCost).toBeCloseTo(below, 9);
    // a sell limit far above the market rests until cancelled
    const sell = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "SELL", shares: 1, limit: 0.99 });
    if (!sell.ok || !sell.working) throw new Error("expected a resting sell");
    expect(await cancelPaperOrder(d, sell.working.id)).toBe(true);
    expect(await cancelPaperOrder(d, sell.working.id)).toBe(false);
  });

  it("a sell stop waits below the price, fires when the price falls to it and sells at market", async () => {
    const id = ok[5]!;
    const m = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, id)))[0]!;
    const buy = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5 });
    if (!buy.ok) throw new Error(buy.error);
    const snap = (await latestSnaps(d.db, [id])).get(id)!;
    const stop = Math.round((snap.mid! - 0.05) * 100) / 100;
    const r = await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "SELL", shares: buy.shares, stop });
    if (!r.ok || !r.working) throw new Error("expected a resting stop");
    expect(r.working).toMatchObject({ kind: "stop", stop, shares: buy.shares });
    expect((await openPos(m.yesTokenId!))[0]!.size).toBeCloseTo(buy.shares, 6); // nothing sold yet
    const crash = { bids: [{ price: stop - 0.02, size: 10_000 }], asks: [{ price: stop, size: 10_000 }] };
    await nextBook(id, crash, stop - 0.01);
    expect(await workPaperOrders(d, [id])).toMatchObject({ triggered: 1, filled: 1 });
    expect(await openPos(m.yesTokenId!)).toHaveLength(0);
    expect((await listPaperOrders(d, id)).closed[0]).toMatchObject({ kind: "stop", status: "filled" });
  });
});

import { fakeJudge, fakeRunner, type AgentRunner, type Triage } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { deps, latestSnaps, placePaperOrder, read, researchMarket, sellFill, snapshotBooks, sweepUniverse, triageMarkets, triageRules, type Deps } from "./index";

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
  ok = all.filter((c) => { const b = snaps.get(c); return b?.book?.asks.length && b.book.bids.length && b.mid != null; });
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

  it("refuses what it cannot fill: no position to sell, a limit nobody meets, no amount", async () => {
    const id = ok[3]!;
    expect(await placePaperOrder(d, { conditionId: id, outcome: "NO", side: "SELL", shares: 1 })).toEqual({ ok: false, error: "you hold no paper NO shares" });
    expect(await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY", usd: 5, limit: 0.0001 })).toEqual({ ok: false, error: "no sellers at or under your limit" });
    expect(await placePaperOrder(d, { conditionId: id, outcome: "YES", side: "BUY" })).toEqual({ ok: false, error: "enter an amount in dollars" });
  });
});

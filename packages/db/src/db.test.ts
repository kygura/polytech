import { beforeAll, describe, expect, it } from "vitest";
import { getDb, insertSnapshots, latestSnapshot, memoryKv, schema as s, tables, UniqueViolation } from "./index";

describe("store (in-process)", () => {
  beforeAll(() => getDb().flush());

  it("insert + read each table", async () => {
    const db = getDb();
    const now = new Date();
    await db.markets.insert({ conditionId: "c1", question: "q?" });
    await insertSnapshots(db, [
      { conditionId: "c1", ts: new Date(now.getTime() - 1000), mid: 0.4 },
      { conditionId: "c1", ts: now, mid: 0.5 },
    ]);
    expect((await latestSnapshot(db, "c1"))?.mid).toBe(0.5);
    await db.screens.insert({ conditionId: "c1", r: 1, tier: "A" });
    await db.screenRuns.insert({ ts: now, rows: 1 });
    await db.pods.insert({ id: "p1", conditionId: "c1", trigger: "manual" });
    await db.agentRuns.insert({ podId: "p1", role: "rules", model: "m", status: "ok", outputJson: { a: 1 }, usage: { in: 1 } });
    await db.evidence.insert({ podId: "p1", agentRole: "news", url: "u", quote: "q", claim: "c", direction: 1 });
    await db.theses.insert({ id: "t1", conditionId: "c1", podId: "p1", pHat: 0.6, c: 0.7, pPost: 0.55, side: "YES", edgeC: 0.05, sizeUsd: 10, catalysts: ["x"] });
    await db.outcomes.insert({ conditionId: "c1", resolvedAt: now, result: "YES", brier: 0.1 });
    await db.orders.insert({ id: "o1", thesisId: "t1", idempotencyKey: "t1:1", conditionId: "c1", tokenId: "tok", side: "BUY", limitPrice: 0.5, size: 5, modeAtSend: "L1", status: "new" });
    await expect(db.orders.insert({ id: "o2", thesisId: "t1", idempotencyKey: "t1:1", conditionId: "c1", tokenId: "tok", side: "BUY", limitPrice: 0.5, size: 5, modeAtSend: "L1", status: "new" })).rejects.toBeInstanceOf(UniqueViolation);
    await db.fills.insert({ orderId: "o1", price: 0.5, size: 5 });
    await db.positions.insert({ conditionId: "c1", tokenId: "tok", size: 5, avgCost: 0.5 });
    await db.autonomyEvents.insert({ fromMode: "L0", toMode: "L1", reason: "r", actor: "user" });
    await db.settings.insert({ data: { bankroll: 1000 } });
    expect((await db.settings.get(1))?.data).toEqual({ bankroll: 1000 });
    await db.marketFlags.insert({ conditionId: "c1", pinned: true });
    await db.spend.insert({ day: "2026-10-15", anthropicUsd: 1.5 });
    await db.rrCache.insert({ conditionId: "c1", rulesHash: "h", r: 0.9, detail: { k: 1 } });
    const prop = { thesisId: "t1", conditionId: "c1", tokenId: "tok", side: "BUY", kind: "entry", sizeUsd: 10, shares: 20, limitPrice: 0.5, expectedProfit: 1, priceAtProposal: 0.5, expiresAt: now, approveTokenHash: "a", rejectTokenHash: "r" };
    await db.proposals.insert(prop);
    await expect(db.proposals.insert(prop)).rejects.toBeInstanceOf(UniqueViolation); // one pending per thesis
    await db.proposals.insert({ ...prop, status: "rejected" }); // non-pending may repeat
    const set = { eventId: "e1", kind: "buy-all", legs: [{ conditionId: "c1", token: "tok", shares: 5, limit: 0.31, price: 0.3 }], shares: 5, totalCost: 1.55, edge: 0.1, expiresAt: now, approveTokenHash: "a", rejectTokenHash: "r" };
    await db.proposalSets.insert(set);
    await expect(db.proposalSets.insert(set)).rejects.toBeInstanceOf(UniqueViolation); // one pending set per event
    await db.reconciliations.insert({ ok: true, usdcLedger: 1, usdcExchange: 1 });
    await db.researchProfiles.insert({ id: "rp1", name: "p", filter: {}, steering: {} });
    expect((await db.fills.all())[0]?.paper).toBe(true);
    // rev 7 tables
    await db.markets.update("c1", { liquidity: 1500, rulesHash: "h", resolutionSource: "official_data" });
    expect(await db.markets.get("c1")).toMatchObject({ liquidity: 1500, negRiskAugmented: false });
    await db.marketLatest.insert({ conditionId: "c1", mid: 0.4, depth2c: 120, largeTrade24h: true, structural: ["ladder"], opportunity: { side: "YES", edge: 0.05, stake: 10, o: 1.2, contrarian: false } });
    expect((await db.marketLatest.all())[0]).toMatchObject({ mid: 0.4, structural: ["ladder"] });
    await db.views.insert({ id: "v1", name: "liq", query: "liq:1k..", columns: ["mid"] });
    expect((await db.views.all())[0]?.columns).toEqual(["mid"]);
    await db.alerts.insert({ conditionId: "c1", kind: "mid_move", message: "m", data: { c: 6 } });
    const al = (await db.alerts.all())[0]!;
    expect(al.ackedAt).toBeNull();
    await db.journal.insert({ thesisId: "t-r7", conditionId: "c1", pHat: 0.6, brierModel: 0.1, paperPnl: 2 });
    expect((await db.journal.all())[0]).toMatchObject({ thesisId: "t-r7", brierModel: 0.1, result: null });
    await db.pods.update("p1", { cancelRequestedAt: now, status: "cancelled", stage: "agents" });
    expect(await db.pods.get("p1")).toMatchObject({ status: "cancelled", stage: "agents", cancelRequestedAt: now });
    // rev 9
    await db.pods.update("p1", { error: "TIMEOUT: x" });
    await db.triage.insert({ conditionId: "c1", verdict: "skip", score: 0, reason: "thin book", failedRules: ["THIN_BOOK"] });
    expect((await db.triage.all())[0]).toMatchObject({ failedRules: ["THIN_BOOK"], model: null });
    // resting paper limits and stops
    await db.paperOrders.insert({ id: "pord_1", conditionId: "c1", tokenId: "tok", outcome: "YES", side: "SELL", kind: "stop", stopPrice: 0.4, shares: 5 });
    expect((await db.paperOrders.all())[0]).toMatchObject({ status: "working", filledShares: 0, limitPrice: null, triggeredAt: null });
    for (const k of Object.keys(tables) as (keyof typeof tables)[]) expect((await db[k].all()).length, k).toBeGreaterThan(0);
    expect((await db.theses.all())[0]?.catalysts).toEqual(["x"]);
    expect(s.markets.name).toBe("markets");
  });
});

describe("memory kv", () => {
  it("lock is exclusive, releasable, and expires", async () => {
    const kv = memoryKv();
    const rel = await kv.lock("a", 30);
    expect(rel).not.toBeNull();
    expect(await kv.lock("a", 30)).toBeNull();
    await rel!();
    const again = await kv.lock("a", 20);
    expect(again).not.toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(await kv.lock("a", 20)).not.toBeNull();
  });

  it("rateLimit window", async () => {
    const kv = memoryKv();
    expect(await kv.rateLimit("ip", 2, 50)).toEqual({ ok: true, remaining: 1 });
    expect((await kv.rateLimit("ip", 2, 50)).ok).toBe(true);
    expect((await kv.rateLimit("ip", 2, 50)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect((await kv.rateLimit("ip", 2, 50)).ok).toBe(true);
  });

  it("evicts expired rateLimit entries", async () => {
    const kv = memoryKv();
    for (let i = 0; i < 1100; i++) await kv.rateLimit(`k${i}`, 1, 5);
    await new Promise((r) => setTimeout(r, 10));
    expect((await kv.rateLimit("fresh", 1, 5)).ok).toBe(true); // sweep runs; no throw, bounded map
  });

  it("caps unexpired rateLimit entries, dropping oldest", async () => {
    const kv = memoryKv();
    for (let i = 0; i < 10_050; i++) await kv.rateLimit(`k${i}`, 1, 60_000);
    expect((await kv.rateLimit("k0", 1, 60_000)).ok).toBe(true); // evicted, so fresh
    expect((await kv.rateLimit("k10049", 1, 60_000)).ok).toBe(false); // newest kept
  }, 30_000);

  it("get/set json with ttl", async () => {
    const kv = memoryKv();
    await kv.set("k", { a: 1 }, 20);
    expect(await kv.get("k")).toEqual({ a: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await kv.get("k")).toBeNull();
  });
});

describe("process-wide singletons", () => {
  it("separate module instances (next dev RSC vs route handler) share one db and one kv", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const a = await import("./client"), ka = await import("./kv");
    vi.resetModules();
    const b = await import("./client"), kb = await import("./kv");
    expect(b.getDb).not.toBe(a.getDb); // really two module instances
    expect(b.getDb()).toBe(a.getDb());
    expect(kb.getKv()).toBe(ka.getKv());
  });
});

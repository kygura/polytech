import { beforeAll, describe, expect, it } from "vitest";
import { getDb, insertSnapshots, latestSnapshot, memoryKv, migrate, schema as s } from "./index";

describe("db (pglite memory)", () => {
  beforeAll(async () => {
    process.env.PGLITE_DIR = "memory://";
    await migrate();
  });

  it("insert + read each table", async () => {
    const db = getDb();
    const now = new Date();
    await db.insert(s.markets).values({ conditionId: "c1", question: "q?" });
    await insertSnapshots(db, [
      { conditionId: "c1", ts: new Date(now.getTime() - 1000), mid: 0.4 },
      { conditionId: "c1", ts: now, mid: 0.5 },
    ]);
    expect((await latestSnapshot(db, "c1"))?.mid).toBe(0.5);
    await db.insert(s.screens).values({ conditionId: "c1", r: 1, tier: "A" });
    await db.insert(s.pods).values({ id: "p1", conditionId: "c1", trigger: "manual" });
    await db.insert(s.agentRuns).values({ podId: "p1", role: "rules", model: "m", status: "ok", outputJson: { a: 1 }, usage: { in: 1 } });
    await db.insert(s.evidence).values({ podId: "p1", agentRole: "news", url: "u", quote: "q", claim: "c", direction: 1 });
    await db.insert(s.theses).values({ id: "t1", conditionId: "c1", podId: "p1", pHat: 0.6, c: 0.7, pPost: 0.55, side: "YES", edgeC: 0.05, sizeUsd: 10, catalysts: ["x"] });
    await db.insert(s.outcomes).values({ conditionId: "c1", resolvedAt: now, result: "YES", brier: 0.1 });
    await db.insert(s.orders).values({ id: "o1", thesisId: "t1", idempotencyKey: "t1:1", conditionId: "c1", tokenId: "tok", side: "BUY", limitPrice: 0.5, size: 5, modeAtSend: "L1", status: "new" });
    await db.insert(s.fills).values({ orderId: "o1", price: 0.5, size: 5 });
    await db.insert(s.positions).values({ conditionId: "c1", tokenId: "tok", size: 5, avgCost: 0.5 });
    await db.insert(s.autonomyEvents).values({ fromMode: "L0", toMode: "L1", reason: "r", actor: "user" });
    await db.insert(s.settings).values({ data: { bankroll: 1000 } });
    await db.insert(s.marketFlags).values({ conditionId: "c1", pinned: true });
    await db.insert(s.spend).values({ day: "2026-10-15", anthropicUsd: 1.5 });
    await db.insert(s.rrCache).values({ conditionId: "c1", rulesHash: "h", r: 0.9, detail: { k: 1 } });
    for (const t of Object.values(s)) expect((await db.select().from(t)).length).toBeGreaterThan(0);
    expect((await db.select().from(s.theses))[0]?.catalysts).toEqual(["x"]);
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
  });

  it("get/set json with ttl", async () => {
    const kv = memoryKv();
    await kv.set("k", { a: 1 }, 20);
    expect(await kv.get("k")).toEqual({ a: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await kv.get("k")).toBeNull();
  });
});

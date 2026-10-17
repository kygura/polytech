import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, fakeExchange, type Exchange } from "@pm/pm";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decide, deps, expireProposals, exposureOf, paperBook, propose, read, researchShortlist, screenAll, setMode, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";
process.env.NTFY_TOPIC = "pm-test";
process.env.APP_URL = "https://app.test";

let t = Date.parse("2026-10-15T12:00:00Z");
const fx = fakeExchange({ now: () => new Date(t) });
let places = 0;
const ex: Exchange = { ...fx, place: (o) => (places++, fx.place(o)) };
let d: Deps;
const events: { type: string; payload: any }[] = [];
const tokens = new Map<string, { approve: string; reject: string }>(); // captured from ntfy pushes
const pushed: any[] = [];

const pending = async () => d.db.select().from(s.proposals).where(eq(s.proposals.status, "pending")).orderBy(s.proposals.createdAt);
const proposal = async (id: string) => (await d.db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!;
const withLimits = (l: Partial<Deps["settings"]["limits"]>) => ({ ...d, settings: { ...d.settings, limits: { ...d.settings.limits, ...l } } });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string);
    pushed.push(b);
    for (const a of b.actions) {
      const { action, token } = JSON.parse(a.body);
      const id = a.url.split("/").at(-2);
      tokens.set(id, { ...(tokens.get(id) ?? { approve: "", reject: "" }), [action]: token });
    }
    return new Response("{}");
  });
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge, exchange: ex });
  subscribe((e) => events.push(e));
  await sweepUniverse(d);
  await snapshotBooks(d, "all");
  await screenAll(d);
  await researchShortlist(d, { limit: 12 });
  await setMode(d, "L1", "test");
  await paperBook(d);
}, 60_000);

describe("live L2 (fake exchange)", () => {
  it("L2 needs a configured exchange", async () => {
    expect(await setMode({ ...d, exchange: null }, "L2", "try")).toMatchObject({ allowed: false, mode: "L1", reason: "EXECUTION_DISABLED" });
    expect((await read.autonomy({ db: d.db, now: d.now })).executionEnabled).toBe(false);
    expect(await propose(d)).toMatchObject({ mode: "L1", proposed: 0 });
    expect(await setMode(d, "L2", "go")).toMatchObject({ allowed: true, mode: "L2" });
    expect(await setMode(d, "L3", "go")).toMatchObject({ allowed: false, mode: "L2" });
    expect(await read.autonomy({ db: d.db, now: d.now, exchangeConfigured: true })).toMatchObject({ mode: "L2", executionEnabled: true, exchangeConfigured: true, pendingCount: 0 });
  });

  it("paper exposure is not counted in live risk", async () => {
    const paper = await exposureOf(d.db, 1000, d.now()), live = await exposureOf(d.db, 1000, d.now(), false);
    expect(paper.totalOpen).toBeGreaterThan(60);
    expect(live.totalOpen).toBe(0);
    const r = await propose(withLimits({ totalOpen: 60 })); // paper alone is over 60; one live trade (<= 50) still fits
    expect(r).toMatchObject({ proposed: 1 });
    const more = await propose(d);
    expect((more as { proposed: number }).proposed).toBeGreaterThan(3);
    expect((await pending()).length).toBe(1 + (more as { proposed: number }).proposed);
    expect(events.filter((e) => e.type === "proposal.created")).toHaveLength((await pending()).length);
    expect(pushed[0].topic).toBe("pm-test");
    expect(pushed[0].actions[0].url).toMatch(/^https:\/\/app\.test\/api\/proposals\/[0-9a-f-]{36}\/push$/);
    expect(JSON.stringify(pushed[0])).not.toMatch(/token_hash|PM_PRIVATE_KEY/);
  });

  it("stores only token hashes; tokens are 32 random bytes", async () => {
    const p = (await pending())[0]!;
    expect(p.approveTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(tokens.get(p.id)!.approve, "base64url")).toHaveLength(32);
    expect(JSON.stringify(p)).not.toContain(tokens.get(p.id)!.approve);
  });

  it("propose -> approve -> send writes one live order", async () => {
    const p = (await pending())[0]!;
    const before = places;
    const r = await decide(d, p.id, "approve", "web");
    expect(r).toMatchObject({ ok: true, state: "sent", orderId: "fake-1" });
    expect(places).toBe(before + 1);
    const after = await proposal(p.id);
    expect(after).toMatchObject({ status: "sent", decidedVia: "web", approveTokenHash: "", rejectTokenHash: "" });
    const o = (await d.db.select().from(s.orders).where(eq(s.orders.id, after.orderId!)))[0]!;
    expect(o).toMatchObject({ paper: false, status: "live", clobOrderId: "fake-1", idempotencyKey: `${p.thesisId}:0`, attempt: 0, size: p.shares, limitPrice: p.limitPrice, approval: "user", modeAtSend: "L2" });
    expect((await fx.openOrders())[0]).toMatchObject({ tokenId: p.tokenId, side: "BUY", price: p.limitPrice, shares: p.shares });
    expect(events.map((e) => e.payload?.state).filter(Boolean)).toEqual(expect.arrayContaining(["sending", "sent"]));
    expect((await exposureOf(d.db, 1000, d.now(), false)).totalOpen).toBeCloseTo(p.shares * p.limitPrice, 6); // open order counts
    const rows = await read.proposals({ db: d.db, now: d.now });
    expect(rows.recent[0]).toMatchObject({ id: p.id, state: "sent", orderId: "fake-1", costUsd: p.shares * p.limitPrice });
    expect(rows.pending.every((x) => x.state === "pending")).toBe(true);
  });

  it("concurrent double approve sends once", async () => {
    const p = (await pending())[0]!;
    const before = places;
    const rs = await Promise.all([decide(d, p.id, "approve", "web"), decide(d, p.id, "approve", "tui")]);
    expect(rs.filter((r) => r.ok && r.state === "sent")).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.error === "ALREADY_DECIDED")).toHaveLength(1);
    expect(places).toBe(before + 1);
    expect(await decide(d, p.id, "approve", "web")).toEqual({ ok: false, error: "ALREADY_DECIDED" });
    expect(places).toBe(before + 1);
  });

  it("push token: wrong, swapped and reused tokens are rejected", async () => {
    const p = (await pending())[0]!, tk = tokens.get(p.id)!;
    expect(await decide(d, p.id, "approve", "push")).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decide(d, p.id, "approve", "push", "nope")).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decide(d, p.id, "approve", "push", tk.reject)).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decide(d, "00000000-0000-4000-8000-000000000000", "reject", "push", tk.reject)).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decide(d, p.id, "reject", "push", tk.reject)).toEqual({ ok: true, state: "rejected" });
    expect(await decide(d, p.id, "reject", "push", tk.reject)).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decide(d, p.id, "approve", "push", tk.approve)).toEqual({ ok: false, error: "INVALID_TOKEN" }); // both burned
    expect(await proposal(p.id)).toMatchObject({ status: "rejected", decidedVia: "push" });
  });

  it("push approve with its token sends", async () => {
    const p = (await pending())[0]!;
    expect(await decide(d, p.id, "approve", "push", tokens.get(p.id)!.approve)).toMatchObject({ ok: true, state: "sent" });
  });

  it("recon mismatch halts approvals and proposing", async () => {
    await d.db.insert(s.reconciliations).values({ ok: false, usdcLedger: 1, usdcExchange: 2 });
    const p = (await pending())[0]!;
    expect(await decide(d, p.id, "approve", "web")).toEqual({ ok: false, error: "orders halted" });
    expect((await proposal(p.id)).status).toBe("pending");
    expect(await propose(d)).toMatchObject({ proposed: 0, skipped: { RECON_HALTED: 1 } });
    await d.db.insert(s.reconciliations).values({ ok: true, usdcLedger: 1, usdcExchange: 1 });
  });

  it("place throws -> order 'unknown', proposal failed, never resent", async () => {
    const p = (await pending())[0]!;
    const before = places;
    fx.failNext(new Error(`socket hang up 0x${"ab".repeat(32)}`));
    const r = await decide(d, p.id, "approve", "web");
    expect(r).toMatchObject({ ok: true, state: "failed" });
    expect((r as { error: string }).error).not.toContain("ab".repeat(32));
    const after = await proposal(p.id);
    expect((await d.db.select().from(s.orders).where(eq(s.orders.id, after.orderId!)))[0]!.status).toBe("unknown");
    expect(await decide(d, p.id, "approve", "web")).toEqual({ ok: false, error: "ALREADY_DECIDED" });
    expect(places).toBe(before + 1);
    expect((await propose(d) as { proposed: number }).proposed).toBe(0); // failed thesis / unknown-order market not re-proposed
  });

  it("risk violation at approve fails the proposal without sending", async () => {
    const p = (await pending())[0]!;
    const before = places;
    const r = await decide(withLimits({ perTradeUsd: 1 }), p.id, "approve", "web");
    expect(r).toMatchObject({ ok: true, state: "failed", error: expect.stringContaining("PER_TRADE_USD") });
    expect(places).toBe(before);
    expect((await proposal(p.id)).orderId).toBeNull();
  });

  it("expiry: PRICE_MOVED on a > 2c move, TIMEOUT after 15 min; expired theses re-proposed unless risk blocks", async () => {
    const p = (await pending())[0]!;
    const snap = (await d.db.select().from(s.snapshots).where(eq(s.snapshots.conditionId, p.conditionId)).orderBy(desc(s.snapshots.ts)).limit(1))[0]!;
    const { id: _, ...copy } = snap;
    await d.db.insert(s.snapshots).values({ ...copy, ts: new Date(d.now()), mid: snap.mid! + 0.03 });
    expect(await expireProposals(d)).toMatchObject({ expired: 1 });
    expect(await proposal(p.id)).toMatchObject({ status: "expired", error: "PRICE_MOVED" });
    const again = await propose(d); // fresh book: the expired thesis comes back as a new pending proposal
    expect(again).toMatchObject({ proposed: 1 });
    const q = (await pending())[0]!;
    expect(q.thesisId).toBe(p.thesisId);
    expect(await expireProposals(d)).toMatchObject({ expired: 0 });
    t += 15 * 60_000;
    expect(await expireProposals(d)).toMatchObject({ expired: 1 });
    expect((await read.proposals({ db: d.db, now: d.now })).recent.find((x) => x.id === q.id)).toMatchObject({ state: "expired", reason: "TIMEOUT", error: null });
    const blocked = await propose(withLimits({ perTradeUsd: 1 }));
    expect(blocked).toMatchObject({ proposed: 0, skipped: { RISK_PER_TRADE_USD: 1 } });
  });
});

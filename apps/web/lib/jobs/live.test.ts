import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, fakeExchange, type Exchange } from "@pm/pm";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decide, deps, downgradeOn, expireProposals, exposureOf, kill, orderUi, paperBook, propose, read, researchShortlist, screenAll, setMode, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

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
let onPush: (() => Promise<unknown>) | undefined; // test hook: runs inside the next ntfy POST
let groups: { c: string; g: string | null }[] = [];

const pending = async () => d.db.select().from(s.proposals).where(eq(s.proposals.status, "pending")).orderBy(s.proposals.createdAt);
const proposal = async (id: string) => (await d.db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!;
const withLimits = (l: Partial<Deps["settings"]["limits"]>) => ({ ...d, settings: { ...d.settings, limits: { ...d.settings.limits, ...l } } });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string);
    pushed.push(b);
    await onPush?.();
    for (const a of b.actions ?? []) {
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
  // structural (neg-risk) legs are skipped in L2; free them so the flow tests have enough proposals, restored in the last test
  groups = (await d.db.select({ c: s.markets.conditionId, g: s.markets.negRiskGroup }).from(s.markets)).filter((x) => x.g);
  await d.db.update(s.markets).set({ negRiskGroup: null });
}, 60_000);

describe("live L2 (fake exchange)", () => {
  it("L2 needs a configured exchange", async () => {
    expect(await setMode({ ...d, exchange: null }, "L2", "try")).toMatchObject({ allowed: false, mode: "L1", reason: "EXECUTION_DISABLED" });
    expect((await read.autonomy({ db: d.db, now: d.now })).executionEnabled).toBe(false);
    expect(await propose(d)).toMatchObject({ mode: "L1", proposed: 0 });
    expect(await setMode(d, "L2", "go")).toMatchObject({ allowed: true, mode: "L2" });
    expect((await d.db.select().from(s.autonomyEvents).orderBy(desc(s.autonomyEvents.id)).limit(1))[0]!.reason).toBe("go (gate not met)"); // advisory gate (0/50 resolved) logged, not blocking
    expect(pushed.at(-1)).toMatchObject({ title: "Mode changed", message: expect.stringContaining("L1 -> L2") });
    expect(pushed.at(-1).actions).toBeUndefined();
    expect(await setMode({ ...d, exchange: null }, "L3", "go")).toMatchObject({ allowed: false, mode: "L2" }); // phase 7: L3+ needs the exchange only
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
    const push = pushed.find((b) => b.actions?.length);
    expect(push.topic).toBe("pm-test");
    expect(push.actions[0].url).toMatch(/^https:\/\/app\.test\/api\/proposals\/[0-9a-f-]{36}\/push$/);
    expect(JSON.stringify(push)).not.toMatch(/token_hash|PM_PRIVATE_KEY/);
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
    expect(rs.filter((r) => !r.ok && (r.error === "busy" || r.error === "ALREADY_DECIDED"))).toHaveLength(1); // lock held => busy
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

describe("live L2 hardening", () => {
  const reset = async () => {
    await d.db.delete(s.proposals);
    await d.db.delete(s.fills).where(eq(s.fills.paper, false));
    await d.db.delete(s.orders).where(eq(s.orders.paper, false));
    await d.db.delete(s.positions).where(eq(s.positions.paper, false));
    await fx.cancelAll();
  };
  /** clean live book, L2, fresh pending proposals */
  const fresh = async () => {
    await reset();
    await setMode(d, "L2", "test");
    await propose(d);
    return pending();
  };
  const openIds = async () => (await fx.openOrders()).map((o) => o.orderId);

  it("orderUi maps every order status", () => {
    expect(orderUi("live", 0, 10)).toBe("open");
    expect(orderUi("live", 3, 10)).toBe("partial");
    expect(orderUi("matched", 3, 10)).toBe("partial");
    expect(orderUi("matched", 10, 10)).toBe("filled");
    expect(orderUi("matched", 10)).toBe("partial"); // shares unknown: never claim filled
    expect(["rejected", "failed_unknown"].map((x) => orderUi(x, 0, 10))).toEqual(["failed", "failed"]);
    expect(["sending", "unknown", "filled", "cancelled", "expired"].map((x) => orderUi(x, 0, 10))).toEqual(["sending", "unknown", "filled", "cancelled", "expired"]);
  });

  it("kill between CAS and place: nothing is sent, order cancelled, proposal failed KILLED", async () => {
    const p = (await fresh())[0]!;
    const before = places;
    const dd = { ...d, db: new Proxy(d.db, { get: (t0: any, k) => { // kill lands right after the order row is written, before place
      const v = t0[k];
      if (k !== "insert") return typeof v === "function" ? v.bind(t0) : v;
      return (tbl: unknown) => { const q = t0.insert(tbl); return tbl !== s.orders ? q : { values: async (x: unknown) => { const r = await q.values(x); await kill({ db: d.db, now: d.now }); return r; } }; };
    } }) } as Deps;
    expect(await decide(dd, p.id, "approve", "web")).toMatchObject({ ok: true, state: "failed", error: "KILLED" });
    expect(places).toBe(before);
    expect(await openIds()).toEqual([]);
    const after = await proposal(p.id);
    expect(after.status).toBe("failed");
    expect((await d.db.select().from(s.orders).where(eq(s.orders.id, after.orderId!)))[0]).toMatchObject({ status: "cancelled", clobOrderId: null });
    expect(pushed.at(-1)).toMatchObject({ title: "Mode changed", message: expect.stringContaining("KILL_SWITCH") });
  });

  it("kill while place is in flight: late order is cancelled on the exchange", async () => {
    const p = (await fresh())[0]!;
    const dd = { ...d, exchange: { ...fx, place: async (o: Parameters<Exchange["place"]>[0]) => { const r = await fx.place(o); await kill({ db: d.db, now: d.now }); return r; } } } as Deps; // kill without exchange: cancelAll cannot catch this order
    expect(await decide(dd, p.id, "approve", "web")).toMatchObject({ ok: true, state: "failed", error: "KILLED" });
    expect(await openIds()).toEqual([]);
    expect((await d.db.select().from(s.orders).where(eq(s.orders.id, (await proposal(p.id)).orderId!)))[0]!.status).toBe("cancelled");
  });

  it("approve is busy while the live-send lock is held; proposal stays pending", async () => {
    const p = (await fresh())[0]!;
    const rel = (await d.kv.lock("job:live-send", 10_000))!;
    const before = places;
    expect(await decide(d, p.id, "approve", "web")).toEqual({ ok: false, error: "busy" });
    expect((await proposal(p.id)).status).toBe("pending");
    expect(places).toBe(before);
    await rel();
    expect(await decide(d, p.id, "approve", "web")).toMatchObject({ ok: true, state: "sent" });
  });

  it("two different proposals approved concurrently cannot both exceed the cap", async () => {
    const [a, b] = await fresh();
    const cost = (x: typeof a) => x!.shares * x!.limitPrice;
    const cap = cost(a) + cost(b) / 2; // room for one, not both
    const dd = withLimits({ totalOpen: cap, perTradeUsd: 1000, perMarket: 1000, perEvent: 1000, perCategory: 1000 });
    const before = places;
    const rs = await Promise.all([decide(dd, a!.id, "approve", "web"), decide(dd, b!.id, "approve", "tui")]);
    expect(rs.filter((r) => r.ok && r.state === "sent")).toHaveLength(1);
    expect(rs.filter((r) => (r.ok && r.state === "failed") || (!r.ok && r.error === "busy"))).toHaveLength(1);
    expect(places).toBe(before + 1);
    expect((await exposureOf(d.db, 1000, d.now(), false)).totalOpen).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("approve-time price policy: limit worse than pPost - 0.02 expires PRICE_MOVED", async () => {
    const p = (await fresh())[0]!;
    await d.db.update(s.proposals).set({ limitPrice: 0.99 }).where(eq(s.proposals.id, p.id));
    const before = places;
    expect(await decide(d, p.id, "approve", "web")).toEqual({ ok: true, state: "expired", reason: "PRICE_MOVED" });
    expect(places).toBe(before);
  });

  it("expireProposals fails 'approved' without an order after 2 min (STUCK_APPROVED)", async () => {
    const [a, b] = await fresh();
    await d.db.update(s.proposals).set({ status: "approved", decidedAt: new Date(t - 3 * 60_000) }).where(eq(s.proposals.id, a!.id));
    await d.db.update(s.proposals).set({ status: "approved", decidedAt: new Date(t) }).where(eq(s.proposals.id, b!.id)); // still within 2 min
    expect(await expireProposals(d)).toMatchObject({ stuck: 1 });
    expect(await proposal(a!.id)).toMatchObject({ status: "failed", error: "STUCK_APPROVED" });
    expect((await proposal(b!.id)).status).toBe("approved");
  });

  it("expireProposals does not fail an approved proposal that already has an order row", async () => {
    const [a] = await fresh();
    await d.db.update(s.proposals).set({ status: "approved", decidedAt: new Date(t - 3 * 60_000) }).where(eq(s.proposals.id, a!.id));
    await d.db.insert(s.orders).values({ id: "ord_hasrow", thesisId: a!.thesisId, idempotencyKey: `${a!.thesisId}:stuckrow`, paper: false, conditionId: a!.conditionId, tokenId: a!.tokenId, side: "BUY", limitPrice: 0.5, size: 1, modeAtSend: "L2", status: "sending", createdAt: new Date(t - 2 * 60_000) });
    expect(await expireProposals(d)).toMatchObject({ stuck: 0 });
    expect((await proposal(a!.id)).status).toBe("approved");
  });

  it("propose stops when killed mid-run (no proposal survives a kill)", async () => {
    await reset();
    await setMode(d, "L2", "test");
    onPush = () => { onPush = undefined; return kill({ db: d.db, now: d.now }); }; // fires inside the first proposal's push
    const r = (await propose(d)) as { proposed: number; skipped: Record<string, number> };
    expect(r.proposed).toBe(1);
    expect(r.skipped.MODE_CHANGED).toBe(1);
    expect(await pending()).toHaveLength(0);
  });

  it("L2 auto-downgrades: daily loss on the live book, stale book falls to L0 not stay L2", async () => {
    await reset();
    await setMode(d, "L2", "test");
    await d.db.insert(s.positions).values({ conditionId: "0xloss", tokenId: "tok", size: 1, avgCost: 0.5, realizedPnl: -10, openedAt: new Date(t), closedAt: new Date(t), paper: false });
    expect(await propose(withLimits({ dailyLoss: 5 }))).toMatchObject({ mode: "L0" });
    expect((await d.db.select().from(s.autonomyEvents).orderBy(desc(s.autonomyEvents.id)).limit(1))[0]).toMatchObject({ toMode: "L0", reason: "DAILY_LOSS_LIMIT", actor: "auto-downgrade" });
    expect(pushed.at(-1)).toMatchObject({ title: "Mode changed", message: expect.stringContaining("DAILY_LOSS_LIMIT") });
    await reset();
    await setMode(d, "L2", "test");
    expect(await downgradeOn(d, { bookStaleMs: 300_001 })).toBe("L0");
    expect(await downgradeOn(d, { bookStaleMs: 300_001 })).toBeNull(); // already L0
  });

  it("structural (neg-risk) theses are not proposed in L2", async () => {
    for (const x of groups) await d.db.update(s.markets).set({ negRiskGroup: x.g }).where(eq(s.markets.conditionId, x.c));
    await reset();
    await setMode(d, "L2", "test");
    expect(((await propose(d)) as { skipped: Record<string, number> }).skipped.STRUCTURAL_PHASE7).toBeGreaterThan(0);
    expect((await pending()).every((p) => !groups.some((g) => g.c === p.conditionId))).toBe(true);
  });
});

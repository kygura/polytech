import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, fakeExchange, type Exchange } from "@pm/pm";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { currentMode, decide, deps, orderUi, expireProposals, kill, propose, read, reconcileJob, rebaseline, setMode, snapshotBooks, subscribe, sweepUniverse, syncFills, screenAll, researchShortlist, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";
delete process.env.NTFY_TOPIC;

const MIN = 60_000;
let t = Date.parse("2026-10-15T12:00:00Z");
const fx = fakeExchange({ now: () => new Date(t) });
let places = 0, landThenThrow = false;
const ex: Exchange = {
  ...fx,
  place: async (o) => {
    places++;
    const r = await fx.place(o);
    if (landThenThrow) throw ((landThenThrow = false), new Error("timeout after send"));
    return r;
  },
};
let d: Deps;
const events: { type: string; payload: any }[] = [];
const big = () => ({ ...d, settings: { ...d.settings, limits: { ...d.settings.limits, perMarket: 1e6, perEvent: 1e6, perCategory: 1e6, totalOpen: 1e6, dailyNotional: 1e6 } } });
const order = async (id: string) => (await d.db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;
const ofProposal = async (id: string) => order((await d.db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!.orderId!);
const pending = () => d.db.select().from(s.proposals).where(eq(s.proposals.status, "pending"));
/** propose (if none pending) and approve the first pending proposal; returns proposal id */
async function approveOne() {
  if (!(await pending()).length) await propose(big());
  const p = (await pending())[0]!;
  await decide(big(), p.id, "approve", "web");
  return p.id;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => new Response("{}"));
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge, exchange: ex });
  subscribe((e) => events.push(e));
  await sweepUniverse(d);
  await snapshotBooks(d, "all");
  await screenAll(d);
  await researchShortlist(d, { limit: 12 });
  await setMode(d, "L2", "test");
}, 60_000);

describe("fill sync + reconcile (fake exchange)", () => {
  it("recon: first run stores baseline", async () => {
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    expect(await read.autonomy({ db: d.db, now: d.now })).toMatchObject({ recon: { status: "ok", detail: null }, liveOpenOrders: 0 });
    expect(events.at(-1)).toMatchObject({ type: "recon.done", payload: { status: "ok", detail: null } });
  });

  it("fill -> position + order partial then filled + events; sync is idempotent", async () => {
    const pid = await approveOne();
    const o = await ofProposal(pid);
    expect(o).toMatchObject({ status: "live", clobOrderId: expect.stringMatching(/^fake-/) });
    fx.fill(o.clobOrderId!, o.size / 2, o.limitPrice - 0.005);
    expect(await syncFills(d)).toMatchObject({ fills: 1 });
    expect(await syncFills(d)).toMatchObject({ fills: 0, updated: 0 }); // same trade again: no-op
    let [pos] = await d.db.select().from(s.positions).where(eq(s.positions.paper, false));
    expect(pos).toMatchObject({ tokenId: o.tokenId, paper: false, closedAt: null });
    expect(pos!.size).toBeCloseTo(o.size / 2, 9);
    expect(await order(o.id)).toMatchObject({ status: "live" });
    expect(events.filter((e) => e.type === "order.updated").at(-1)!.payload).toMatchObject({ orderId: o.clobOrderId, status: "partial", filledShares: o.size / 2 });
    const book = await read.bookLive({ db: d.db, now: d.now });
    expect(book.openOrders[0]).toMatchObject({ orderId: o.clobOrderId, side: "BUY", price: o.limitPrice, shares: o.size, filledShares: o.size / 2, status: "partial" });

    fx.fill(o.clobOrderId!);
    expect(await syncFills(d)).toMatchObject({ fills: 1 });
    expect(await order(o.id)).toMatchObject({ status: "filled" });
    [pos] = await d.db.select().from(s.positions).where(eq(s.positions.paper, false));
    expect(pos!.size).toBeCloseTo(o.size, 9);
    expect(events.filter((e) => e.type === "order.filled")).toHaveLength(2);
    expect(events.filter((e) => e.type === "order.updated").at(-1)!.payload).toMatchObject({ status: "filled", filledShares: o.size });
    const fills = await d.db.select().from(s.fills).where(eq(s.fills.paper, false));
    expect(fills.map((f) => f.tradeId).every(Boolean)).toBe(true);

    const b = await read.bookLive({ db: d.db, now: d.now });
    expect(b.openOrders).toEqual([]);
    expect(b.positions[0]).toEqual({ conditionId: o.conditionId, question: expect.any(String), tokenId: o.tokenId, outcome: expect.stringMatching(/^(YES|NO)$/), shares: o.size, avgPrice: expect.any(Number), markPrice: expect.any(Number), unrealizedUsd: expect.any(Number) });
    expect(b.fills).toHaveLength(2);
    expect(Object.keys(b.fills[0]!).sort()).toEqual(["at", "conditionId", "feeUsd", "price", "question", "shares", "side", "tradeId"]);
    expect(b.recon.status).toBe("ok");
  });

  it("recon ok after fills, mismatch halts proposing", async () => {
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    fx.setBalance((await fx.balance()).usdc + 25);
    expect(await reconcileJob(d)).toMatchObject({ status: "mismatch" });
    expect(events.at(-1)).toMatchObject({ type: "recon.done", payload: { status: "mismatch", detail: expect.stringContaining("usdc") } });
    expect(await currentMode(d.db)).toBe("L2"); // core: balance mismatch only lowers L3+; halt does the work at L2
    expect(await propose(big())).toMatchObject({ proposed: 0, skipped: { RECON_HALTED: 1 } });
    expect((await read.autonomy({ db: d.db, now: d.now })).recon).toMatchObject({ status: "mismatch" });
    fx.setBalance((await fx.balance()).usdc - 25);
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
  });

  it("recon: position drift is a mismatch; stale last run reads 'late'", async () => {
    const tok = (await d.db.select().from(s.positions).where(eq(s.positions.paper, false)))[0]!.tokenId;
    const real = ex.positions;
    (ex as any).positions = async () => ({ [tok]: 1 });
    expect(await reconcileJob(d)).toMatchObject({ status: "mismatch" });
    (ex as any).positions = real;
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    t += 11 * MIN;
    expect((await read.autonomy({ db: d.db, now: d.now })).recon.status).toBe("late");
  });

  it("'unknown' order that landed is resolved by (token, side, price, shares) match, no resend", async () => {
    await propose(big());
    landThenThrow = true;
    const before = places;
    const pid = await approveOne();
    const o = await ofProposal(pid);
    expect(o).toMatchObject({ status: "unknown", clobOrderId: null });
    expect(await syncFills(d)).toBeTruthy();
    expect(await order(o.id)).toMatchObject({ status: "live", clobOrderId: expect.stringMatching(/^fake-/) });
    expect(places).toBe(before + 1);
    expect((await read.autonomy({ db: d.db, now: d.now })).liveOpenOrders).toBe(1);
  });

  it("unmatched 'unknown' -> failed_unknown after 10 min, event published, never resent", async () => {
    const before = places;
    fx.failNext(new Error("socket hang up")); // place throws before reaching the venue
    const pid = await approveOne();
    const o = await ofProposal(pid);
    expect(o).toMatchObject({ status: "unknown", clobOrderId: null });
    await syncFills(d);
    expect((await order(o.id)).status).toBe("unknown"); // too young
    t += 10 * MIN;
    expect(await syncFills(d)).toMatchObject({ failedUnknown: 1 });
    expect((await order(o.id)).status).toBe("failed_unknown");
    expect(events.some((e) => e.type === "order.error" && e.payload.id === o.id)).toBe(true);
    expect((await d.db.select().from(s.proposals).where(eq(s.proposals.id, pid)))[0]).toMatchObject({ status: "failed", error: "ORDER_FAILED_UNKNOWN" });
    expect(events.some((e) => e.type === "proposal.updated" && e.payload.id === pid && e.payload.error === "ORDER_FAILED_UNKNOWN")).toBe(true);
    await syncFills(d);
    expect(places).toBe(before + 1); // the one failed attempt, nothing resent
  });

  const reraise = () => setMode(d, "L2", "test"); // sync auto-downgrades after 3 failed orders
  let seqO = 0;
  const mkOrder = async (v: Partial<typeof s.orders.$inferInsert>) => {
    const n = ++seqO;
    await d.db.insert(s.orders).values({ id: `ord_x${n}`, thesisId: `th_x${n}`, idempotencyKey: `th_x${n}:0`, conditionId: "c", tokenId: "tokX", side: "BUY", limitPrice: 0.4, size: 10, modeAtSend: "L2", paper: false, createdAt: new Date(d.now()), status: "sending", ...v });
    return `ord_x${n}`;
  };
  const lastRecon = async () => (await d.db.select().from(s.reconciliations).orderBy(desc(s.reconciliations.id)).limit(1))[0]!;

  it("'matched' order with no trade ever -> failed_unknown after 10 min", async () => {
    const id = await mkOrder({ status: "matched", clobOrderId: "fake-ghost", createdAt: new Date(t - 11 * MIN) });
    expect(await syncFills(d)).toMatchObject({ failedUnknown: 1 });
    expect((await order(id)).status).toBe("failed_unknown");
    expect(orderUi("matched", 10, 10)).toBe("filled"); // fully matched order reads filled; with shares omitted it would read partial
  });

  it("ambiguous match (2 candidates) is never resent and never attached", async () => {
    const exp = new Date(t + 3_600_000), before = places;
    const mk = () => fx.place({ tokenId: "tokX", side: "BUY", price: 0.4, shares: 10, expiresAt: exp });
    const [a, b] = [await mk(), await mk()];
    const id = await mkOrder({ status: "unknown" });
    await syncFills(d);
    expect(await order(id)).toMatchObject({ status: "unknown", clobOrderId: null });
    t += 10 * MIN;
    expect(await syncFills(d)).toMatchObject({ failedUnknown: 1 });
    expect(await order(id)).toMatchObject({ status: "failed_unknown", clobOrderId: null });
    expect(events.some((e) => e.type === "order.error" && e.payload.id === id && e.payload.error === "AMBIGUOUS_MATCH")).toBe(true);
    expect(places).toBe(before);
    await fx.cancel([a.orderId, b.orderId]);
  });

  it("concurrent reconcile + sync with an unsynced fill: no false mismatch", async () => {
    await reraise();
    const o = (await fx.openOrders()).find((x) => x.filled < x.shares && x.tokenId !== "tokX")!;
    t += 1000;
    fx.fill(o.orderId, 0.5);
    const [r] = await Promise.all([reconcileJob(d), syncFills(d)]);
    expect(r).not.toMatchObject({ status: "mismatch" });
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
  });

  it("rebaseline refused (409 text) while an order is sending/unknown", async () => {
    await reraise();
    await expireProposals(d); // clock jumped: stale pending ones would be refused
    fx.failNext(new Error("socket hang up"));
    const o = await ofProposal(await approveOne());
    expect(o.status).toBe("unknown");
    expect(await rebaseline(d)).toEqual({ ok: false, error: expect.stringContaining("sending or unknown") });
    t += 10 * MIN;
    await syncFills(d);
    expect((await order(o.id)).status).toBe("failed_unknown");
  });

  it("deposit -> mismatch halts -> rebaseline ok, clears halt, keeps mode", async () => {
    await reraise();
    fx.setBalance((await fx.balance()).usdc + 500);
    expect(await reconcileJob(d)).toMatchObject({ status: "mismatch" });
    expect(await rebaseline(d)).toMatchObject({ ok: true });
    expect(await lastRecon()).toMatchObject({ ok: true, baseline: true });
    expect(events.at(-1)).toMatchObject({ type: "recon.done", payload: { status: "ok", detail: "rebaseline" } });
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    expect(await currentMode(d.db)).toBe("L2");
    expect(await propose(big())).not.toMatchObject({ skipped: { RECON_HALTED: expect.anything() } });
  });

  it("pre-existing holdings are captured in the baseline, later fills still reconcile", async () => {
    const real = ex.positions;
    (ex as any).positions = async () => ({ ...(await real()), tokPre: 7 });
    expect(await reconcileJob(d)).toMatchObject({ status: "mismatch" });
    expect(await rebaseline(d)).toMatchObject({ ok: true });
    expect((await lastRecon()).positions).toMatchObject({ tokPre: 7 });
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    const o = (await fx.openOrders()).find((x) => x.filled < x.shares)!;
    t += 1000;
    fx.fill(o.orderId, 0.25);
    expect(await reconcileJob(d)).toMatchObject({ status: "ok" });
    (ex as any).positions = real;
    expect(await rebaseline(d)).toMatchObject({ ok: true });
  });

  it("kill cancels all live orders, expires pending proposals, returns counts", async () => {
    if (!(await pending()).length) await propose(big());
    const livePending = (await pending()).length;
    expect(livePending).toBeGreaterThan(0);
    const openNow = (await fx.openOrders()).length;
    expect(openNow).toBeGreaterThan(0);
    const r = await kill({ db: d.db, now: d.now, exchange: ex });
    expect(r).toMatchObject({ mode: "L0", cancelled: openNow, failed: [] });
    expect(await fx.openOrders()).toEqual([]);
    expect(await pending()).toEqual([]);
    expect((await d.db.select().from(s.proposals).where(eq(s.proposals.error, "KILLED"))).length).toBe(livePending);
    expect(events.some((e) => e.type === "proposal.updated" && e.payload.reason === "KILLED")).toBe(true);
    expect(await d.db.select().from(s.orders).where(eq(s.orders.status, "live"))).toEqual([]);
  });

  it("kill: cancelAll throws -> still L0, failed lists open orders with scrubbed error", async () => {
    await setMode(d, "L2", "again");
    await propose(big());
    const pid = await approveOne();
    const o = await ofProposal(pid);
    fx.failNext(new Error(`venue down 0x${"ab".repeat(32)}`));
    const r = await kill({ db: d.db, now: d.now, exchange: ex });
    expect(await currentMode(d.db)).toBe("L0");
    expect(r.cancelled).toBe(0);
    expect(r.failed).toContainEqual({ orderId: o.clobOrderId, error: expect.stringContaining("venue down") });
    expect(JSON.stringify(r)).not.toContain("ab".repeat(32));
    expect((await order(o.id)).status).toBe("live"); // not marked cancelled
  });

  it("3 consecutive order failures auto-downgrade to L0", async () => {
    await setMode(d, "L2", "again");
    const mk = (i: number, status: string) => d.db.insert(s.orders).values({
      id: `ord_err${i}`, thesisId: `th_err${i}`, idempotencyKey: `th_err${i}:0`, conditionId: "c", tokenId: "tok", side: "BUY", limitPrice: 0.5, size: 1,
      modeAtSend: "L2", status, paper: false, createdAt: new Date(d.now()),
    });
    await mk(1, "rejected");
    await mk(2, "rejected");
    await syncFills(d);
    expect(await currentMode(d.db)).toBe("L2");
    await mk(3, "failed_unknown");
    await syncFills(d);
    expect(await currentMode(d.db)).toBe("L0");
    const ev = (await d.db.select().from(s.autonomyEvents)).at(-1)!;
    expect(ev).toMatchObject({ reason: "ORDER_ERRORS", actor: "auto-downgrade" });
    await setMode(d, "L2", "again"); // old failures predate this raise: not re-downgraded
    await syncFills(d);
    expect(await currentMode(d.db)).toBe("L2");
  });

  it("no exchange: sync and reconcile are no-ops", async () => {
    expect(await syncFills({ ...d, exchange: null })).toMatchObject({ fills: 0 });
    expect(await reconcileJob({ ...d, exchange: null })).toEqual({ status: null });
  });
});

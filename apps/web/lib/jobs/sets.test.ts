import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, fakeExchange, type Book, type Exchange, type ImmediateOrder, type ImmediateResult, type Pm } from "@pm/pm";
import { and, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ackSet, decideSet, deps, halted, kill, proposeSets, read, reconcileJob, setMode, subscribe, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";
process.env.NTFY_TOPIC = "pm-test";
process.env.APP_URL = "https://app.test";

let t = Date.parse("2026-10-15T12:00:00Z");
const fx = fakeExchange({ now: () => new Date(t) });
const placed: ImmediateOrder[] = [];
let after: ((o: ImmediateOrder, r: ImmediateResult) => Promise<void> | void) | undefined; // test hook, runs after each placeImmediate
const ex: Exchange = {
  ...fx,
  placeImmediate: async (o) => {
    placed.push(o);
    const r = await fx.placeImmediate(o);
    await after?.(o, r);
    return r;
  },
};
const books = new Map<string, Book>();
let d: Deps;
const events: { type: string; payload: any }[] = [];
const pushed: any[] = [];
const tokens = new Map<string, { approve: string; reject: string }>();

const setRow = async (id: string) => (await d.db.select().from(s.proposalSets).where(eq(s.proposalSets.id, id)))[0]!;
const setOrders = async (id: string) => d.db.select().from(s.orders).where(eq(s.orders.setId, id)).orderBy(s.orders.createdAt);
let gn = 0;
/** New neg-risk group with n legs + a fresh structural detection (older detections removed). price = YES ask (buy-all) or YES bid (sell-all). */
async function group(kind: "buy-all" | "sell-all", sizes: number[], price: number, dep = d) {
  const g = `g${++gn}`;
  await d.db.delete(s.screens);
  const legs = sizes.map((_, i) => `${g}-c${i}`);
  await d.db.insert(s.markets).values(legs.map((c) => ({ conditionId: c, question: `${g} outcome ${c}?`, category: "politics", negRiskGroup: g, eventId: g, feeRate: 0, yesTokenId: `${c}-Y`, noTokenId: `${c}-N`, status: "active" })));
  sizes.forEach((sz, i) => quote(legs[i]!, kind === "buy-all" ? { ask: price, bid: price - 0.04, askSz: sz, bidSz: 1000 } : { ask: price + 0.04, bid: price, askSz: 1000, bidSz: sz }));
  await d.db.insert(s.screens).values(legs.map((c) => ({ conditionId: c, ts: new Date(t), structuralFlag: true, structuralDetail: { type: "neg-risk-sum", kind, legs, lockedC: 1, sum: 0, sizeUsd: 50 } })));
  const r = await proposeSets(dep);
  expect(r).toMatchObject({ proposed: 1 });
  const p = (await d.db.select().from(s.proposalSets).where(eq(s.proposalSets.eventId, g)))[0]!;
  return { g, legs, p };
}
const quote = (c: string, q: { ask: number; bid: number; askSz: number; bidSz: number }) =>
  books.set(`${c}-Y`, { token_id: `${c}-Y`, asks: [{ price: q.ask, size: q.askSz }], bids: [{ price: q.bid, size: q.bidSz }] });

beforeAll(async () => {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string);
    pushed.push(b);
    for (const a of b.actions ?? []) {
      const { action, token } = JSON.parse(a.body);
      const id = a.url.split("/").at(-2);
      tokens.set(id, { ...(tokens.get(id) ?? { approve: "", reject: "" }), [action]: token });
    }
    return new Response("{}");
  });
  const pm = { ...createPm({ fixtures: true }), books: async (ts: string[]) => ts.flatMap((x) => (books.has(x) ? [books.get(x)!] : [])), oi: async () => ({}), trades: async () => [] } as unknown as Pm;
  d = await deps({ pm, kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge, exchange: ex });
  d.settings = { ...d.settings, limits: { ...d.settings.limits, perMarket: 1e6, perEvent: 1e6, perCategory: 1e6, totalOpen: 1e6, dailyNotional: 1e6 } };
  subscribe((e) => events.push(e));
  await setMode(d, "L2", "test");
  expect(await reconcileJob(d)).toMatchObject({ status: "ok" }); // baseline before any set
}, 60_000);

describe("neg-risk sets (fake exchange)", () => {
  it("buy-all: 3 legs thinnest first, all FOK filled, fills booked by sync", async () => {
    const { p, legs } = await group("buy-all", [500, 300, 800], 0.3);
    expect(p).toMatchObject({ kind: "buy-all", status: "pending", approveTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(p.legs.map((l) => l.conditionId)).toEqual([legs[1], legs[0], legs[2]]);
    expect(p.legs.every((l) => l.limit === 0.31 && l.shares === p.shares)).toBe(true);
    expect(p.totalCost).toBeLessThanOrEqual(50 + 1e-9); // capFrac x bankroll
    expect(p.edge).toBeCloseTo(p.shares * 0.07, 6);
    expect(pushed.at(-1).actions[0].url).toBe(`https://app.test/api/sets/${p.id}/push`);
    expect(events.find((e) => e.type === "proposal.created" && e.payload.id === p.id)?.payload.kind).toBe("set");

    const n = placed.length;
    expect(await decideSet(d, p.id, "approve", "web")).toEqual({ ok: true, state: "filled" });
    expect(placed.slice(n).map((o) => [o.tokenId, o.side, o.type, o.capPrice])).toEqual(p.legs.map((l) => [l.token, "BUY", "FOK", 0.31]));
    const os = await setOrders(p.id);
    expect(os.map((o) => [o.idempotencyKey, o.status, o.thesisId])).toEqual(p.legs.map((_, i) => [`set:${p.id}:${i}`, "filled", `set:${p.id}`]));
    const fills = await d.db.select().from(s.fills).where(eq(s.fills.paper, false));
    expect(fills.filter((f) => os.some((o) => o.id === f.orderId))).toHaveLength(3);
    const pos = await d.db.select().from(s.positions).where(eq(s.positions.paper, false));
    expect(pos.filter((x) => x.tokenId.startsWith(p.eventId))).toHaveLength(3);
    expect(await setRow(p.id)).toMatchObject({ status: "filled", decidedVia: "web", approveTokenHash: "", rejectTokenHash: "" });
    expect(events.filter((e) => e.type === "set.updated" && e.payload.id === p.id).at(-1)?.payload).toMatchObject({ state: "filled", legsFilled: 3, legsTotal: 3 });
    const v = await read.proposals({ db: d.db, now: d.now });
    expect(v.sets.recent.find((x) => x.id === p.id)).toMatchObject({ setKind: "buy-all", state: "filled", legs: [{ state: "filled", token: "YES", capPrice: 0.31 }, {}, {}] });
  });

  it("sell-all buys NO on every leg", async () => {
    const { p } = await group("sell-all", [400, 400, 400], 0.4);
    expect(p.legs.every((l) => l.token.endsWith("-N") && l.limit === 0.61)).toBe(true);
    const n = placed.length;
    expect(await decideSet(d, p.id, "approve", "tui")).toMatchObject({ state: "filled" });
    expect(placed.slice(n).every((o) => o.side === "BUY" && o.tokenId.endsWith("-N"))).toBe(true);
  });

  it("double approve sends once", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    const n = placed.length;
    const rs = await Promise.all([decideSet(d, p.id, "approve", "web"), decideSet(d, p.id, "approve", "tui")]);
    expect(rs.filter((r) => r.ok && r.state === "filled")).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && (r.error === "busy" || r.error === "ALREADY_DECIDED"))).toHaveLength(1);
    expect(placed.length - n).toBe(3);
    expect(await decideSet(d, p.id, "approve", "web")).toEqual({ ok: false, error: "ALREADY_DECIDED" });
    expect(placed.length - n).toBe(3);
  });

  it("first leg killed: nothing held => failed", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    fx.scriptImmediate(p.legs[0]!.token, 0);
    expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "failed" });
    expect(await setRow(p.id)).toMatchObject({ status: "failed", failedLeg: 0 });
    expect((await setOrders(p.id)).map((o) => o.status)).toEqual(["cancelled"]);
  });

  it("mid-set FOK killed => earlier legs unwound with capped FAK SELL => unwound", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    fx.scriptImmediate(p.legs[2]!.token, 1); // FOK with 1 < shares is killed
    const n = placed.length;
    expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "unwound", error: expect.stringContaining("leg 3") });
    const sells = placed.slice(n).filter((o) => o.side === "SELL");
    expect(sells.map((o) => [o.tokenId, o.type, o.capPrice, o.shares])).toEqual([0, 1].map((i) => [p.legs[i]!.token, "FAK", 0.29, p.shares]));
    const os = await setOrders(p.id);
    expect(os.map((o) => o.idempotencyKey)).toEqual([`set:${p.id}:0`, `set:${p.id}:1`, `set:${p.id}:2`, `set:${p.id}:u0`, `set:${p.id}:u1`]);
    expect(await setRow(p.id)).toMatchObject({ status: "unwound", failedLeg: 2 });
    expect(await halted(d)).toBe(false);
  });

  it("unwind FAK partial => flagged, push alert, halts new sends until acknowledged", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    after = (o) => { if (o.side === "BUY" && o.tokenId === p.legs[0]!.token) { fx.scriptImmediate(p.legs[1]!.token, 0); fx.scriptImmediate(o.tokenId, 10); } }; // leg 2 killed; leg 1 unwind sells only 10
    expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "flagged", error: expect.stringContaining("held") });
    after = undefined;
    expect(pushed.at(-1)).toMatchObject({ title: "Set flagged: manual action", priority: 5 });
    expect(await halted(d)).toBe(true);
    expect(await proposeSets(d)).toMatchObject({ skipped: { HALTED: 1 } });
    const v = (await read.proposals({ db: d.db, now: d.now })).sets.recent.find((x) => x.id === p.id)!;
    expect(v.held).toEqual([expect.objectContaining({ token: "YES", shares: p.shares - 10, avgFill: expect.closeTo(0.31, 9) })]);
    expect(v.suggestedAction).toMatch(/^SELL [\d.]+ YES on Polymarket, bid 0\.260$/);
    expect((await read.autonomy({ db: d.db, now: d.now })).flaggedSets).toBe(1);
    expect(await ackSet(d, p.id)).toEqual({ ok: true, state: "acknowledged" });
    expect(await ackSet(d, p.id)).toEqual({ ok: false, error: "NOT_FLAGGED" });
    expect(await halted(d)).toBe(false);
    expect((await d.db.select().from(s.autonomyEvents).where(like(s.autonomyEvents.scope, "set:%"))).length).toBe(1);
  });

  it("place throws => leg unknown, set flagged, no resend, no unwind", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    after = (o) => { if (o.tokenId === p.legs[0]!.token) fx.failNext(new Error("socket hang up")); };
    const n = placed.length;
    expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "flagged", error: expect.stringContaining("leg 2 unknown") });
    after = undefined;
    expect(placed.slice(n).map((o) => o.side)).toEqual(["BUY", "BUY"]); // leg 3 never sent, leg 1 never unwound
    expect((await setOrders(p.id)).map((o) => o.status)).toEqual(["filled", "unknown"]);
    expect(await decideSet(d, p.id, "approve", "web")).toEqual({ ok: false, error: "ALREADY_DECIDED" });
    expect(placed.length - n).toBe(2);
    expect((await read.proposals({ db: d.db, now: d.now })).sets.recent.find((x) => x.id === p.id)?.suggestedAction).toMatch(/^Check the venue: 1 leg order/);
    await ackSet(d, p.id);
  });

  it("kill mid-set stops placing, unwinds filled legs", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    after = async (o) => { if (o.side === "BUY") { after = undefined; await kill(d); } };
    const n = placed.length;
    expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "unwound", error: "leg 2: KILLED" });
    expect(placed.slice(n).map((o) => o.side)).toEqual(["BUY", "SELL"]);
    expect(await setMode(d, "L2", "back")).toMatchObject({ allowed: true });
  });

  it("kill expires pending sets", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    await kill(d);
    expect(await setRow(p.id)).toMatchObject({ status: "expired", error: "KILLED" });
    await setMode(d, "L2", "back");
  });

  it("expiry: touch above cap or timeout", async () => {
    const a = await group("buy-all", [600, 600, 600], 0.3);
    quote(a.legs[1]!, { ask: 0.33, bid: 0.29, askSz: 600, bidSz: 600 });
    const n = placed.length;
    expect(await decideSet(d, a.p.id, "approve", "web")).toEqual({ ok: true, state: "expired", reason: "PRICE_MOVED" });
    const b = await group("buy-all", [600, 600, 600], 0.3);
    t += 16 * 60_000;
    expect(await decideSet(d, b.p.id, "approve", "web")).toEqual({ ok: true, state: "expired", reason: "TIMEOUT" });
    expect(placed.length).toBe(n);
  });

  it("push token: wrong/swapped rejected, approve token sends, then burned", async () => {
    const { p } = await group("buy-all", [600, 600, 600], 0.3);
    const tk = tokens.get(p.id)!;
    expect(await decideSet(d, p.id, "approve", "push")).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decideSet(d, p.id, "approve", "push", tk.reject)).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await decideSet(d, p.id, "approve", "push", tk.approve)).toMatchObject({ ok: true, state: "filled" });
    expect(await decideSet(d, p.id, "reject", "push", tk.reject)).toEqual({ ok: false, error: "INVALID_TOKEN" });
    expect(await setRow(p.id)).toMatchObject({ decidedVia: "push" });
  });

  it("recon ledger stays balanced after filled, unwound and flagged sets", async () => {
    expect(await reconcileJob(d)).toMatchObject({ status: "ok", mismatches: 0 });
  });

  describe("L3/L4 auto", () => {
    const withL3 = (l3: Partial<Deps["settings"]["limits"]["l3"]>) => ({ ...d, settings: { ...d.settings, limits: { ...d.settings.limits, l3: { ...d.settings.limits.l3, perTradeUsd: 1e6, dailyNotional: 1e6, categoryAllowlist: ["politics"], ...l3 } } } });
    const orders = async (id: string) => (await setOrders(id)).filter((o) => o.side === "BUY");

    it("L3 with structuralAuto off falls back to approval, then a user approval sends", async () => {
      await setMode(d, "L3", "test");
      const { p } = await group("buy-all", [600, 600, 600], 0.3, withL3({ structuralAuto: false }));
      expect(p).toMatchObject({ status: "pending", fallbackReason: "STRUCTURAL_AUTO_OFF" });
      expect(pushed.at(-1).actions).toHaveLength(2);
      expect(await decideSet(d, p.id, "approve", "web")).toMatchObject({ state: "filled" });
      expect((await orders(p.id)).every((o) => o.approval === "user" && o.modeAtSend === "L3")).toBe(true);
    });

    it("L3 with structuralAuto on and inside limits sends automatically", async () => {
      const n = placed.length;
      const { p } = await group("buy-all", [600, 600, 600], 0.3, withL3({ structuralAuto: true }));
      expect(p).toMatchObject({ status: "filled", decidedVia: "auto", fallbackReason: null });
      expect(placed.length - n).toBe(3);
      expect((await orders(p.id)).every((o) => o.approval === "auto" && o.modeAtSend === "L3")).toBe(true);
    });

    it("L3 over the per-trade limit falls back to approval", async () => {
      const n = placed.length;
      const { p } = await group("buy-all", [600, 600, 600], 0.3, withL3({ structuralAuto: true, perTradeUsd: 1 }));
      expect(p).toMatchObject({ status: "pending", fallbackReason: "PER_TRADE" });
      expect(placed.length).toBe(n);
    });

    it("L4 sends automatically; a recon halt blocks the auto path", async () => {
      await setMode(d, "L4", "test");
      const { p } = await group("sell-all", [400, 400, 400], 0.4);
      expect(p).toMatchObject({ status: "filled", decidedVia: "auto" });
      expect((await orders(p.id)).every((o) => o.approval === "auto" && o.modeAtSend === "L4")).toBe(true);
      await d.db.insert(s.reconciliations).values({ ok: false, usdcLedger: 1, usdcExchange: 2 });
      const n = placed.length;
      expect(await proposeSets(d)).toMatchObject({ proposed: 0, skipped: { HALTED: 1 } });
      expect(placed.length).toBe(n);
      await d.db.insert(s.reconciliations).values({ ok: true, usdcLedger: 1, usdcExchange: 1 });
    });
  });
});

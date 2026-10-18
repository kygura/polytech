import { fakeExchange } from "@pm/pm/exchange";
import { describe, expect, it } from "vitest";
import type { PublicMarketDetail } from "../public";
import { buildExposure, decide, entryOf, LEDGER_KEY, loadLedger, pickCandidates, recheck, sendEntry, toLiveBook, type Candidate, type DecideInput, type Ledger, type LedgerStore } from "./autonomy";
import { DEFAULT_VISITOR_SETTINGS, loadVisitorSettings, saveVisitorSettings, SETTINGS_KEY, type VisitorSettings } from "./settings";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const store = (): LedgerStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
const lv = (p: number, n = 2000) => ({ price: p, size: n });
const settings = (mode: VisitorSettings["mode"], l3: Partial<VisitorSettings["limits"]["l3"]> = {}, lim: Partial<VisitorSettings["limits"]> = {}): VisitorSettings => ({
  ...DEFAULT_VISITOR_SETTINGS, mode, limits: { ...DEFAULT_VISITOR_SETTINGS.limits, ...lim, l3: { ...DEFAULT_VISITOR_SETTINGS.limits.l3, categoryAllowlist: ["politics"], perTradeUsd: 100, ...l3 } },
});
const detail = (o: { id?: string; cid?: string; snapAge?: number; research?: "done" | "pending" } = {}): PublicMarketDetail => ({
  market: { conditionId: o.cid ?? "c1", question: "Will X?", rules: "r", category: "politics", tags: [], eventId: "e1", negRiskGroup: null, endDate: NOW + 30 * 86_400_000, daysLeft: 30, status: "active", yesTokenId: "y1", noTokenId: "n1", feeRate: 0, negRisk: false },
  snapshot: { ts: NOW - (o.snapAge ?? 60_000), mid: 0.5, bestBid: 0.49, bestAsk: 0.51, depth5cUsd: 500, vol24h: 1000, oi: 1000, top10Share: 0.2, bids: [], asks: [], netFlow: 0 },
  history: [], screen: null,
  thesis: { id: o.id ?? "t1", createdAt: NOW - 3_600_000, expiresAt: NOW + 5 * 86_400_000, side: "YES", pHat: 0.7, c: 0.8, pPost: 0.66, edgeC: 15, catalysts: [], killCriteria: [], thesis: "t", pYes: 0.7, pMidYes: 0.5, capped: false } as unknown as PublicMarketDetail["thesis"],
  thesisMarkers: [], evidence: [], agents: [], research: o.research ?? "done",
});
const cand = (o?: Parameters<typeof detail>[0]): Candidate => ({ detail: detail(o), book: { bids: [lv(0.48), lv(0.47)], asks: [lv(0.5), lv(0.51), lv(0.52)], tick: 0.01, minShares: 5 } });
const input = (mode: VisitorSettings["mode"], over: Partial<DecideInput> = {}): DecideInput => {
  const s = over.settings ?? settings(mode);
  return { watchlist: { snapshotAt: NOW - 60_000, research: "on" }, candidates: [cand()], settings: s, exposure: buildExposure({ bankroll: s.bankroll, positions: {}, orders: [], ledger: {}, info: {}, now: NOW }), ledger: {}, now: NOW, ...over };
};

describe("decide", () => {
  it("manual: nothing", () => expect(decide(input("manual"))).toEqual([]));
  it("L2 proposes with a live-book limit", () => {
    const [a] = decide(input("L2"));
    expect(a).toMatchObject({ kind: "propose", thesisId: "t1", conditionId: "c1", tokenId: "y1", side: "YES", reason: "L2_APPROVE" });
    expect(a!.limitPrice).toBeGreaterThanOrEqual(0.5);
    expect(a!.limitPrice).toBeLessThan(0.66); // pPost 0.66, livelimitPrice bound pPost - 0.02
    expect(a!.sizeUsd).toBeCloseTo(a!.shares * a!.limitPrice, 6);
    expect(a!.sizeUsd).toBeGreaterThan(0);
  });
  it("L3 sends inside the caps, falls back to propose when the daily auto cap or category fails", () => {
    expect(decide(input("L3"))[0]).toMatchObject({ kind: "send", reason: "L3_AUTO" });
    expect(decide(input("L3", { settings: settings("L3", { dailyNotional: 1 }) }))[0]).toMatchObject({ kind: "propose", reason: "DAILY_AUTO_NOTIONAL" });
    expect(decide(input("L3", { settings: settings("L3", { perTradeUsd: 1 }) }))[0]).toMatchObject({ kind: "propose", reason: "PER_TRADE" });
    expect(decide(input("L3", { settings: settings("L3", { categoryAllowlist: [] }) }))[0]).toMatchObject({ kind: "propose", reason: "CATEGORY_NOT_ALLOWED" });
    // today's auto notional already near the cap
    const led: Ledger = { z: { ...entryOf(decide(input("L2"))[0]!, NOW), thesisId: "z", status: "sent", via: "auto", sizeUsd: 149 } };
    expect(decide(input("L3", { ledger: led }))[0]).toMatchObject({ kind: "propose", reason: "DAILY_AUTO_NOTIONAL" });
  });
  it("L4 sends without the l3 caps", () => expect(decide(input("L4", { settings: settings("L4", { categoryAllowlist: [], perTradeUsd: 1 }) }))[0]).toMatchObject({ kind: "send", reason: "L4_AUTO" }));
  it("checkOrder violation skips in every live mode", () => {
    for (const m of ["L2", "L3", "L4"] as const) {
      const s = settings(m, {}, { perTradeUsd: 1 });
      expect(decide(input(m, { settings: s }))[0]).toMatchObject({ kind: "skip", reason: expect.stringContaining("RISK_PER_TRADE_USD") });
    }
  });
  it("skips stale data (watchlist and market), unfinished research, no edge", () => {
    expect(decide(input("L4", { watchlist: { snapshotAt: NOW - 3 * 3_600_000, research: "on" } }))[0]).toMatchObject({ kind: "skip", reason: "STALE_DATA" });
    expect(decide(input("L4", { watchlist: { snapshotAt: null, research: "on" } }))[0]).toMatchObject({ reason: "STALE_DATA" });
    expect(decide(input("L4", { candidates: [cand({ snapAge: 3 * 3_600_000 })] }))[0]).toMatchObject({ reason: "STALE_DATA" });
    expect(decide(input("L4", { candidates: [cand({ research: "pending" })] }))[0]).toMatchObject({ reason: "NO_RESEARCH" });
    const flat = cand();
    flat.book = { ...flat.book, asks: [lv(0.72)], bids: [lv(0.7)] };
    expect(decide(input("L4", { candidates: [flat] }))[0]).toMatchObject({ kind: "skip", reason: "NO_EDGE_NOW" });
  });
  it("skips a thesis already in the ledger (any status but expired)", () => {
    const e = entryOf(decide(input("L2"))[0]!, NOW);
    for (const status of ["queued", "sending", "sent", "unknown", "failed", "rejected"] as const)
      expect(decide(input("L4", { ledger: { t1: { ...e, status } } }))[0]).toMatchObject({ kind: "skip", reason: "DUPLICATE" });
    expect(decide(input("L4", { ledger: { t1: { ...e, status: "expired" } } }))[0]!.kind).toBe("send");
  });
  it("skips a market already held, and later candidates see earlier exposure", () => {
    const s = settings("L4", {}, { perMarket: 1000, perEvent: 60 });
    const x = buildExposure({ bankroll: s.bankroll, positions: { y1: 10 }, orders: [], ledger: {}, info: { y1: { conditionId: "c1", eventId: "e1", category: "politics", price: 0.5 } }, now: NOW });
    expect(decide(input("L4", { settings: s, exposure: x }))[0]).toMatchObject({ kind: "skip", reason: "HELD" });
    const two = decide(input("L4", { settings: s, candidates: [cand(), cand({ id: "t2", cid: "c2" })] }));
    expect(two.map((a) => a.kind)).toEqual(["send", "skip"]); // same event e1: 2nd breaches perEvent 60
    expect(two[1]!.reason).toContain("RISK_PER_EVENT");
  });
  it("recheck: timeout, price move, risk", () => {
    const a = decide(input("L2"))[0]!, e = entryOf(a, NOW), c = cand(), x = input("L2").exposure;
    expect(recheck(e, c, x, settings("L2"), NOW + 60_000)).toBeNull();
    expect(recheck(e, c, x, settings("L2"), NOW + 11 * 60_000)).toEqual({ status: "expired", reason: "TIMEOUT" });
    expect(recheck({ ...e, sideMid: 0.4 }, c, x, settings("L2"), NOW + 60_000)).toEqual({ status: "expired", reason: "PRICE_MOVED" });
    expect(recheck(e, c, x, settings("L2", {}, { perTradeUsd: 1 }), NOW + 60_000)?.status).toBe("failed");
  });
});

describe("pickCandidates / toLiveBook / buildExposure", () => {
  it("filters and caps", () => {
    const row = (i: number, o: object = {}) => ({ conditionId: `c${i}`, thesisId: `t${i}`, research: "done", expired: false, capped: false, edgeC: i, ...o });
    const w = { rows: [row(1), row(2, { research: "pending" }), row(3, { expired: true }), row(4), row(5, { thesisId: null }), row(6), row(7, { capped: true })] } as never;
    expect(pickCandidates(w, {}, 2).map((r) => r.conditionId)).toEqual(["c6", "c4"]);
    expect(pickCandidates(w, { t6: { status: "sent" } } as never, 5).map((r) => r.conditionId)).toEqual(["c4", "c1"]);
  });
  it("parses wire books", () => {
    const b = toLiveBook({ bids: [{ price: "0.4", size: "10" }, { price: "x", size: "1" }, { price: "1.5", size: "1" }], asks: [{ price: "0.6", size: "0" }], tickSize: "0.001", minOrderSize: "5" });
    expect(b).toEqual({ bids: [{ price: 0.4, size: 10 }], asks: [], tick: 0.001, minShares: 5 });
  });
  it("exposure: positions at ledger cost, unmapped at 1, open orders by remainder, pending ledger today", () => {
    const e = { ...entryOf(decide(input("L2"))[0]!, NOW), status: "unknown" as const, sizeUsd: 20, limitPrice: 0.5, tokenId: "y1" };
    const x = buildExposure({ bankroll: 1000, positions: { y1: 10, other: 3 }, orders: [{ orderId: "o", tokenId: "y1", side: "BUY", price: 0.5, shares: 10, filled: 4 }], ledger: { t1: e }, info: {}, now: NOW });
    expect(x.byMarket.c1).toBeCloseTo(5 + 3 + 20); // position 10@0.5 + order 6@0.5 + unknown ledger 20
    expect(x.totalOpen).toBeCloseTo(5 + 3 + 20 + 3);
    expect(x.dailyNotional).toBe(20);
  });
});

describe("settings", () => {
  it("missing / corrupt / invalid -> defaults (manual)", () => {
    const s = store();
    expect(loadVisitorSettings(s)).toEqual(DEFAULT_VISITOR_SETTINGS);
    for (const bad of ["{", "null", JSON.stringify({ ...DEFAULT_VISITOR_SETTINGS, mode: "L9" }), JSON.stringify({ ...DEFAULT_VISITOR_SETTINGS, kelly: 5 }), JSON.stringify({ mode: "L4" })]) {
      s.m.set(SETTINGS_KEY, bad);
      expect(loadVisitorSettings(s)).toEqual(DEFAULT_VISITOR_SETTINGS);
    }
  });
  it("save validates, roundtrips", () => {
    const s = store(), v = settings("L3");
    expect(() => saveVisitorSettings({ ...v, bankroll: -1 }, s)).toThrow();
    expect(s.m.size).toBe(0);
    saveVisitorSettings(v, s);
    expect(loadVisitorSettings(s)).toEqual(v);
  });
});

describe("sendEntry ledger", () => {
  const entry = () => entryOf(decide(input("L4"))[0]!, NOW);
  it("sends once; a second call never resends", async () => {
    const s = store(), ex = fakeExchange(), e = entry();
    const r = await sendEntry(ex, e, "auto", s, NOW);
    expect(r.status).toBe("sent");
    expect((await ex.openOrders()).length).toBe(1);
    expect((await sendEntry(ex, e, "auto", s, NOW)).status).toBe("sent");
    expect((await ex.openOrders()).length).toBe(1);
  });
  it("place throws -> unknown, ledger written before place, never resent", async () => {
    const s = store(), ex = fakeExchange(), e = entry();
    let seen: string | undefined;
    ex.place = async () => { seen = loadLedger(s).t1?.status; throw new Error("socket hang up"); };
    const r = await sendEntry(ex, e, "auto", s, NOW);
    expect(seen).toBe("sending");
    expect(r).toMatchObject({ status: "unknown", error: "socket hang up" });
    let calls = 0;
    ex.place = async () => { calls++; return { orderId: "x", status: "live" }; };
    expect((await sendEntry(ex, e, "auto", s, NOW + 1000)).status).toBe("unknown");
    expect((await sendEntry(ex, { ...e, status: "queued" }, "user", s, NOW + 2000)).status).toBe("unknown");
    expect(calls).toBe(0);
    expect(decide(input("L4", { ledger: loadLedger(s) }))[0]).toMatchObject({ kind: "skip", reason: "DUPLICATE" });
  });
  it("rejected -> failed; kill before place -> failed, nothing sent; corrupt ledger throws", async () => {
    const s = store(), ex = fakeExchange(), e = entry();
    expect((await sendEntry(ex, e, "auto", s, NOW, () => false)).error).toBe("KILLED");
    expect((await ex.openOrders()).length).toBe(0);
    const s2 = store();
    ex.failNext("venue says no");
    expect((await sendEntry(ex, e, "auto", s2, NOW)).status).toBe("failed");
    s2.m.set(LEDGER_KEY, "{");
    await expect(sendEntry(ex, e, "auto", s2, NOW)).rejects.toThrow(/corrupt/);
  });
});

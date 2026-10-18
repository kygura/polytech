import { describe, expect, it } from "vitest";
import type { PublicMarketDetail } from "../../lib/public";
import { onTick, placeTicketOrder, prefill, quote, ticketGate, validate } from "./ticket";

const detail = (over: Partial<PublicMarketDetail> = {}): PublicMarketDetail => ({
  market: { conditionId: "c1", question: "Q?", rules: "", category: "politics", tags: [], eventId: null, negRiskGroup: null, endDate: null, daysLeft: 30, status: "active", yesTokenId: "y", noTokenId: "n", feeRate: 0, negRisk: false },
  snapshot: {
    ts: 0, mid: 0.4, bestBid: 0.39, bestAsk: 0.41, depth5cUsd: 0, vol24h: 0, oi: 0, top10Share: 0, netFlow: 0,
    bids: [{ price: 0.39, size: 10_000 }], asks: [{ price: 0.41, size: 10_000 }],
  },
  history: [], screen: null, thesisMarkers: [], evidence: [], agents: [], research: "done",
  thesis: { id: "t", createdAt: 0, expiresAt: null, side: "YES", pHat: 0.6, c: 0.8, pPost: 0.56, edgeC: 15, rAnn: 1, catalysts: [], killCriteria: [], thesis: "", pYes: 0.6, pMidYes: 0.4, capped: false },
  ...over,
} as PublicMarketDetail);

describe("ticket prefill", () => {
  it("thesis side, limit on tick, size from bankroll = balance", () => {
    const p = prefill(detail(), 1000);
    expect(p.side).toBe("YES");
    expect(p.price).toBe(0.41);
    expect(p.amount).toBeGreaterThan(0);
    expect(p.amount).toBeLessThanOrEqual(50); // capFrac 0.05 * 1000
  });
  it("no balance: limit only; no thesis: best ask; no edge at the ask: best ask, no amount", () => {
    expect(prefill(detail(), null)).toEqual({ side: "YES", price: 0.41, amount: null });
    expect(prefill(detail({ thesis: null }), 1000)).toEqual({ side: "YES", price: 0.41, amount: null });
    const noEdge = detail();
    noEdge.thesis = { ...noEdge.thesis!, pPost: 0.42, pYes: 0.42 };
    expect(prefill(noEdge, 1000)).toEqual({ side: "YES", price: 0.41, amount: null });
  });
  it("NO side prices off the mirrored bids", () => {
    const d = detail();
    d.thesis = { ...d.thesis!, side: "NO", pYes: 0.2, pPost: 0.75 };
    expect(prefill(d, null).price).toBe(0.61);
  });
});

describe("ticket quote + validate", () => {
  it("shares round down, max loss = cost + fee", () => {
    const q = quote(0.42, 100, 0.04)!;
    expect(q.shares).toBe(238.09);
    expect(q.maxLoss).toBeCloseTo(238.09 * 0.42 + 0.04 * 0.42 * 0.58 * 238.09, 9);
    expect(quote(0.42, 0, 0)).toBeNull();
  });
  it("errors", () => {
    expect(validate(1.2, 10, 100, quote(0.5, 10, 0))).toMatchObject({ price: expect.stringMatching(/between/) });
    expect(validate(0.5, 200, 100, quote(0.5, 200, 0))).toEqual({ amount: "Amount exceeds your balance" });
    expect(validate(0.5, 10, 100, quote(0.5, 10, 0))).toEqual({});
    expect(validate(0.5, null, null, null)).toEqual({ amount: "Enter an amount" });
  });
});

describe("ticket gate", () => {
  const ok = { wallet: "connected", chainOk: true, region: "ok", credsReady: true, approved: true } as const;
  it("first unmet precondition wins, in order", () => {
    expect(ticketGate(ok)).toBeNull();
    expect(ticketGate({ ...ok, wallet: "disconnected", chainOk: false, region: "blocked" })).toBe("disconnected");
    expect(ticketGate({ ...ok, chainOk: false, region: "blocked" })).toBe("wrong_network");
    expect(ticketGate({ ...ok, region: "failed", credsReady: false })).toBe("geo_failed");
    expect(ticketGate({ ...ok, region: "idle" })).toBe("geo_checking");
    expect(ticketGate({ ...ok, credsReady: false, approved: false })).toBe("creds_needed");
    expect(ticketGate({ ...ok, approved: false })).toBe("allowance_needed");
    expect(ticketGate({ ...ok, approved: null })).toBe("allowance_checking");
    expect(ticketGate({ ...ok, region: "blocked" })).toBe("geo_blocked");
    expect(ticketGate({ ...ok, region: "checking" })).toBe("geo_checking");
    expect(ticketGate({ ...ok, wallet: "connecting" })).toBe("disconnected");
    expect(ticketGate({ ...ok, wallet: "unavailable" })).toBe("disconnected");
  });
});

describe("tick rounding", () => {
  it("rounds the limit down to the tick; quote and validate use the rounded price", () => {
    expect(onTick(0.4199)).toBe(0.41);
    expect(onTick(0.42)).toBe(0.42);
    expect(quote(0.4299, 100, 0)!.shares).toBe(quote(0.42, 100, 0)!.shares);
    expect(validate(0.995, 10, null, quote(0.995, 10, 0))).toEqual({});
    expect(validate(0.005, 10, null, quote(0.005, 10, 0)).price).toMatch(/between/);
  });
});

describe("placeTicketOrder", () => {
  const order = { tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, expiresAt: new Date(Date.now() + 3_600_000) };
  const no = () => false;
  it("unknown outcome: a throw then the order among open orders ends open with that id", async () => {
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [{ orderId: "o9", tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, filled: 0 }] };
    expect(await placeTicketOrder(ex, order, no)).toEqual({ kind: "open", orderId: "o9" });
  });
  it("unknown outcome, not found (or lookup fails): unknown, never resent", async () => {
    let placed = 0;
    const ex = { place: async () => { placed++; throw new Error("timeout"); }, openOrders: async () => { throw new Error("down"); } };
    expect(await placeTicketOrder(ex, order, no)).toEqual({ kind: "unknown" });
    expect(placed).toBe(1);
  });
  it("wallet rejection: declined; venue rejection: rejected", async () => {
    const rej = { place: async () => { throw new Error("User rejected"); }, openOrders: async () => [] };
    expect(await placeTicketOrder(rej, order, () => true)).toEqual({ kind: "declined" });
    const v = { place: async () => ({ orderId: "", status: "rejected" as const, error: "bad" }), openOrders: async () => [] };
    expect(await placeTicketOrder(v, order, no)).toEqual({ kind: "rejected", error: "bad" });
  });
});

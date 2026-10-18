import { describe, expect, it } from "vitest";
import type { PublicMarketDetail } from "../../lib/public";
import { findPlaced, onTick, onTickUp, roundTick, tickDecimals, placeTicketOrder, prefill, quote, sellQuote, ticketGate, validate, validateSell } from "./ticket";

const detail = (over: Partial<PublicMarketDetail> = {}): PublicMarketDetail => ({
  market: { conditionId: "c1", question: "Q?", rules: "", category: "politics", tags: [], eventId: null, negRiskGroup: null, endDate: null, daysLeft: 30, status: "active", tickSize: null, yesTokenId: "y", noTokenId: "n", feeRate: 0, negRisk: false },
  snapshot: {
    ts: 0, mid: 0.4, bestBid: 0.39, bestAsk: 0.41, depth5cUsd: 0, vol24h: 0, oi: 0, top10Share: 0, netFlow: 0,
    bids: [{ price: 0.39, size: 10_000 }], asks: [{ price: 0.41, size: 10_000 }],
  },
  history: [], screen: null, thesisMarkers: [], evidence: [], agents: [], research: "done",
  thesis: { id: "t", createdAt: 0, expiresAt: null, side: "YES", pHat: 0.6, c: 0.8, pPost: 0.56, edgeC: 15, rAnn: 1, catalysts: [], killCriteria: [], thesis: "", pYes: 0.6, pMidYes: 0.4, capped: false },
  ...over,
} as PublicMarketDetail);

const nowait = async () => {};
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
    const q = quote(0.42, 100, 0.04, 0.01)!;
    expect(q.shares).toBe(238.09);
    expect(q.maxLoss).toBeCloseTo(238.09 * 0.42 + 0.04 * 0.42 * 0.58 * 238.09, 9);
    expect(quote(0.42, 0, 0, 0.01)).toBeNull();
  });
  it("errors", () => {
    expect(validate(1.2, 10, 100, quote(0.5, 10, 0, 0.01), 0.01)).toMatchObject({ price: expect.stringMatching(/between/) });
    expect(validate(0.5, 200, 100, quote(0.5, 200, 0, 0.01), 0.01)).toEqual({ amount: "Amount exceeds your balance" });
    expect(validate(0.5, 10, 100, quote(0.5, 10, 0, 0.01), 0.01)).toEqual({});
    expect(validate(0.5, null, null, null, 0.01)).toEqual({ amount: "Enter an amount" });
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
    expect(onTick(0.4199, 0.01)).toBe(0.41);
    expect(onTick(0.42, 0.01)).toBe(0.42);
    expect(quote(0.4299, 100, 0, 0.01)!.shares).toBe(quote(0.42, 100, 0, 0.01)!.shares);
    expect(validate(0.995, 10, null, quote(0.995, 10, 0, 0.01), 0.01)).toEqual({});
    expect(validate(0.005, 10, null, quote(0.005, 10, 0, 0.01), 0.01).price).toMatch(/between/);
  });
  it("0.001 market: rounds, quotes and validates on the market tick", () => {
    expect(onTick(0.4569, 0.001)).toBe(0.456);
    expect(onTick(0.457, 0.001)).toBe(0.457);
    expect(quote(0.4569, 100, 0, 0.001)!.shares).toBe(quote(0.456, 100, 0, 0.001)!.shares);
    expect(validate(0.003, 10, null, quote(0.003, 10, 0, 0.001), 0.001)).toEqual({});
    expect(validate(0.0004, 10, null, quote(0.0004, 10, 0, 0.001), 0.001).price).toBe("Price must be between 0.001 and 0.999");
  });
  it("tickDecimals", () => {
    expect([0.1, 0.01, 0.001, 0.0001].map(tickDecimals)).toEqual([1, 2, 3, 4]);
    expect(onTick(0.45678, 0.0001).toFixed(tickDecimals(0.0001))).toBe("0.4567");
  });
  it("prefill limit lands on the market tick", () => {
    const p = prefill(detail({ market: { ...detail().market, tickSize: 0.001 } }), 1000);
    expect(p.price).not.toBeNull();
    expect(Math.abs(p.price! * 1000 - Math.round(p.price! * 1000))).toBeLessThan(1e-6);
  });
});

describe("placeTicketOrder", () => {
  const order = { tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, expiresAt: new Date(Date.now() + 3_600_000) };
  const no = () => false;
  it("unknown outcome: a throw then the order among open orders ends open with that id", async () => {
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [{ orderId: "o9", tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, filled: 0 }], trades: async () => [] };
    expect(await placeTicketOrder(ex, order, no, nowait)).toEqual({ kind: "open", orderId: "o9" });
  });
  it("unknown outcome, not found (or lookup fails): unknown, never resent", async () => {
    let placed = 0;
    const ex = { place: async () => { placed++; throw new Error("timeout"); }, openOrders: async () => { throw new Error("down"); }, trades: async () => [] };
    expect(await placeTicketOrder(ex, order, no, nowait)).toEqual({ kind: "unknown" });
    expect(placed).toBe(1);
  });
  it("unknown outcome, filled on arrival: no open order, but the trades show the fill", async () => {
    const trade = { tradeId: "t1", orderId: "o7", tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, fee: 0.1, at: new Date() };
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [], trades: async () => [trade] };
    expect(await placeTicketOrder(ex, order, no, nowait)).toMatchObject({ kind: "filled", shares: 10, fee: 0.1 });
  });
  it("unknown outcome, filled on arrival at a better price than the limit: still filled, never unknown", async () => {
    const trade = { tradeId: "t2", orderId: "o8", tokenId: "y", side: "BUY" as const, price: 0.4, shares: 10, fee: 0.1, at: new Date() };
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [], trades: async () => [trade] };
    expect(await placeTicketOrder(ex, order, no, nowait)).toMatchObject({ kind: "filled", shares: 10 });
  });
  it("unknown outcome: a fill above a BUY limit or before the send window is not ours", async () => {
    const worse = { tradeId: "t3", orderId: "o3", tokenId: "y", side: "BUY" as const, price: 0.43, shares: 10, fee: 0.1, at: new Date() };
    const old = { ...worse, tradeId: "t4", price: 0.42, at: new Date(Date.now() - 120_000) };
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [], trades: async (after?: Date) => [worse, old].filter((t) => !after || t.at >= after) };
    expect(await placeTicketOrder(ex, order, no, nowait)).toMatchObject({ kind: "unknown" });
  });
  it("unknown outcome: the trade index lags, the fill shows up on a re-check", async () => {
    const trade = { tradeId: "t5", orderId: "o5", tokenId: "y", side: "BUY" as const, price: 0.42, shares: 10, fee: 0.1, at: new Date() };
    let calls = 0;
    const ex = { place: async () => { throw new Error("socket hang up"); }, openOrders: async () => [], trades: async () => (++calls >= 2 ? [trade] : []) };
    expect(await placeTicketOrder(ex, order, no, nowait)).toMatchObject({ kind: "filled", shares: 10 });
    expect(calls).toBe(2);
  });
  it("wallet rejection: declined; venue rejection: rejected", async () => {
    const rej = { place: async () => { throw new Error("User rejected"); }, openOrders: async () => [], trades: async () => [] };
    expect(await placeTicketOrder(rej, order, () => true)).toEqual({ kind: "declined" });
    const v = { place: async () => ({ orderId: "", status: "rejected" as const, error: "bad" }), openOrders: async () => [], trades: async () => [] };
    expect(await placeTicketOrder(v, order, no)).toEqual({ kind: "rejected", error: "bad" });
  });
});

describe("sell quote + validate", () => {
  it("proceeds = shares x tick-rounded-up price - taker fee; shares round down to 0.01", () => {
    const q = sellQuote(0.42, 100.019, 0.04, 0.01)!;
    expect(q.shares).toBe(100.01);
    expect(q.fee).toBeCloseTo(0.04 * 0.42 * 0.58 * 100.01, 9);
    expect(q.proceeds).toBeCloseTo(100.01 * 0.42 - q.fee, 9);
    expect(sellQuote(0.4299, 10, 0, 0.01)!.proceeds).toBeCloseTo(4.3, 9); // rounds up to 0.43
    expect(sellQuote(0.42, 0, 0, 0.01)).toBeNull();
    expect(sellQuote(0.42, 0.004, 0, 0.01)).toBeNull();
    expect(sellQuote(1.2, 10, 0, 0.01)).toBeNull();
  });
  it("0.001 market prices at the 0.001 tick", () => {
    expect(sellQuote(0.4569, 100, 0, 0.001)!.proceeds).toBeCloseTo(45.7, 9);
    expect(validateSell({ price: 0.003, shares: 5, held: 5, tick: 0.001, outcome: "YES" })).toEqual({});
    expect(validateSell({ price: 0.0004, shares: 5, held: 5, tick: 0.001, outcome: "YES" })).toEqual({}); // rounds up to 0.001
    expect(validateSell({ price: 0.9995, shares: 5, held: 5, tick: 0.001, outcome: "YES" }).price).toBe("Price must be between 0.001 and 0.999"); // would round to 1
    expect(validateSell({ price: 0.999, shares: 5, held: 5, tick: 0.001, outcome: "YES" })).toEqual({});
    expect(sellQuote(0.9995, 5, 0, 0.001)).toBeNull();
  });
  it("shares: nothing held, over the held cap, empty, below the venue minimum", () => {
    expect(validateSell({ price: 0.5, shares: 5, held: 0, tick: 0.01, outcome: "YES" }).shares).toBe("No YES shares to sell");
    expect(validateSell({ price: 0.5, shares: 5, held: 0, tick: 0.01, outcome: "NO" }).shares).toBe("No NO shares to sell");
    expect(validateSell({ price: 0.5, shares: 5.01, held: 5, tick: 0.01, outcome: "YES" }).shares).toBe("You hold 5 YES shares");
    expect(validateSell({ price: 0.5, shares: 5, held: 5, tick: 0.01, outcome: "YES" })).toEqual({}); // exactly the held cap
    expect(validateSell({ price: 0.5, shares: null, held: 5, tick: 0.01, outcome: "YES" }).shares).toBe("Enter shares to sell");
    expect(validateSell({ price: 0.5, shares: 3, held: 5, tick: 0.01, outcome: "YES", minShares: 5 }).shares).toBe("Minimum order is 5 shares");
    expect(validateSell({ price: 0.5, shares: 3, held: 5, tick: 0.01, outcome: "YES", minShares: null })).toEqual({});
  });
});

describe("side-aware tick rounding", () => {
  it("SELL rounds up, BUY down, on-tick unchanged", () => {
    expect(roundTick("SELL", 0.4567, 0.001)).toBe(0.457);
    expect(roundTick("BUY", 0.4567, 0.001)).toBe(0.456);
    for (const side of ["BUY", "SELL"] as const) {
      expect(roundTick(side, 0.457, 0.001)).toBe(0.457);
      expect(roundTick(side, 0.42, 0.01)).toBe(0.42);
      expect(roundTick(side, 0.1 + 0.2, 0.01)).toBe(0.3); // float noise on a tick
    }
    expect(onTickUp(0.4101, 0.01)).toBe(0.42);
    expect(onTickUp(0.999, 0.001)).toBe(0.999); // 1-tick bound not exceeded when already on it
  });
});

describe("findPlaced fill direction", () => {
  const trade = (side: "BUY" | "SELL", price: number) => ({ tradeId: "t", orderId: "o", tokenId: "y", side, price, shares: 10, fee: 0, at: new Date() });
  const ex = (tr: ReturnType<typeof trade>) => ({ openOrders: async () => [], trades: async () => [tr] });
  const order = (side: "BUY" | "SELL") => ({ tokenId: "y", side, price: 0.5, shares: 10, expiresAt: new Date() });
  it("SELL: a fill above the limit is filled, below is not", async () => {
    expect((await findPlaced(ex(trade("SELL", 0.52)), order("SELL"), Date.now())).kind).toBe("filled");
    expect((await findPlaced(ex(trade("SELL", 0.5)), order("SELL"), Date.now())).kind).toBe("filled");
    expect((await findPlaced(ex(trade("SELL", 0.48)), order("SELL"), Date.now())).kind).toBe("unknown");
  });
  it("BUY: a fill below the limit is filled, above is not", async () => {
    expect((await findPlaced(ex(trade("BUY", 0.48)), order("BUY"), Date.now())).kind).toBe("filled");
    expect((await findPlaced(ex(trade("BUY", 0.5)), order("BUY"), Date.now())).kind).toBe("filled");
    expect((await findPlaced(ex(trade("BUY", 0.52)), order("BUY"), Date.now())).kind).toBe("unknown");
  });
  it("validateSell min size uses the floored shares actually sent", () => {
    expect(validateSell({ price: 0.5, shares: 5.004, held: 9, tick: 0.01, outcome: "YES", minShares: 5 })).toEqual({});
    expect(validateSell({ price: 0.5, shares: 4.999, held: 9, tick: 0.01, outcome: "YES", minShares: 5 }).shares).toBe("Minimum order is 5 shares");
  });
});

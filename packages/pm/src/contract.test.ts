// Contract tests: recorded live responses (fixtures/contract, captured 2026-10-20) through the real client code with a mocked fetch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createPm } from "./index";
import { normHolders, normOi, normTrades, toIso } from "./schemas";

const fx = (name: string): any => JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/contract", name), "utf8"));
const meta = fx("meta.json") as { conditionId: string; tokens: string[] };
const C = meta.conditionId, T = meta.tokens[0]!;

let routes: Array<[RegExp, () => unknown]> = [];
let urls: URL[] = [];
let bodies: unknown[] = [];
const route = (re: RegExp, body: unknown | (() => unknown)) => routes.unshift([re, typeof body === "function" ? (body as () => unknown) : () => body]);
const fetchMock = (async (url: URL, init?: RequestInit) => {
  urls.push(new URL(String(url)));
  if (init?.body) bodies.push(JSON.parse(String(init.body)));
  for (const [re, body] of routes)
    if (re.test(String(url))) {
      const b = body();
      return b instanceof Response ? b : new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    }
  return new Response(JSON.stringify({ error: "no route (test)" }), { status: 404 });
}) as unknown as typeof fetch;
const pm = createPm({ fixtures: false, fetch: fetchMock, sleep: async () => {} });
beforeEach(() => { routes = []; urls = []; bodies = []; });
const q = (i = 0) => urls[i]!.searchParams;

describe("gamma", () => {
  it("listMarkets normalises a real keyset page and sends the server-side filters", async () => {
    route(/\/markets\/keyset/, () => (urls.length === 1 ? fx("gamma-markets.json") : { markets: [] }));
    const ms = await pm.listMarkets({ liquidityMin: 2000, endDateMin: "2026-11-01T00:00:00.000Z" });
    expect(q().get("closed")).toBe("false");
    expect(q().get("liquidity_num_min")).toBe("2000");
    expect(q().get("end_date_min")).toBe("2026-11-01T00:00:00.000Z");
    expect(q(1).get("after_cursor")).toBe(fx("gamma-markets.json").next_cursor); // cursor followed, filters repeated
    expect(q(1).get("liquidity_num_min")).toBe("2000");
    expect(ms).toHaveLength(5);
    for (const m of ms) {
      expect(m.id).toMatch(/^\d+$/);
      expect(m.condition_id).toMatch(/^0x[0-9a-f]{64}$/);
      expect(m.yes_token_id).toMatch(/^\d+$/);
      expect(m.no_token_id).toMatch(/^\d+$/);
      expect(m.outcomes).toHaveLength(2);
      expect(m.outcome_prices).toHaveLength(2);
      expect(m.yes_price).toBe(m.outcome_prices[Math.max(0, m.outcomes.findIndex((o) => o.toLowerCase() === "yes"))]); // non yes/no markets: outcome 0
      expect(m.liquidity).toBeTypeOf("number");
      expect(m.volume_24h).toBeTypeOf("number");
      expect(m.end_date).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(m.event_id).toMatch(/^\d+$/);
      expect(m.tags.length).toBeGreaterThan(0);
      expect(m.open && m.accepting_orders).toBe(true);
    }
  });
  it("fees: fee_bps from feeSchedule.rate, 0 only when feesEnabled=false, undefined when Gamma says nothing", async () => {
    route(/\/markets\/keyset/, () => (urls.length === 1 ? fx("gamma-markets.json") : { markets: [] }));
    const ms = await pm.listMarkets();
    const v3 = ms.find((m) => m.fee_type === "sports_fees_v3")!;
    expect(v3.fee_schedule).toEqual({ rate: 0.05, exponent: 1, taker_only: true, rebate_rate: 0.15 });
    expect(v3.fee_bps).toBe(500);
    expect(ms.find((m) => m.fee_type === "sports_fees_v2")!.fee_bps).toBe(300);
    const none = ms.find((m) => m.fees_enabled === false)!;
    expect(none.fee_bps).toBe(0);
    expect(none.fee_schedule).toBeUndefined();
    route(/\/markets\/1$/, { id: "1", conditionId: "0x1", question: "q" });
    const bare = (await pm.market("1"))!;
    expect(bare.fee_bps).toBeUndefined();
    expect(bare.fees_enabled).toBeUndefined();
  });
  it("events: nested markets inherit the event id, neg-risk flags and the negRiskMarketID group", async () => {
    route(/\/events\/keyset/, () => (urls.length === 1 ? fx("gamma-events.json") : { events: [] }));
    const evs = await pm.listEvents({ liquidityMin: 2000, tagId: 5 });
    expect(q().get("liquidity_min")).toBe("2000");
    expect(q().get("tag_id")).toBe("5");
    expect(q().get("closed")).toBe("false");
    const raw = fx("gamma-events.json").events as any[];
    expect(evs.map((e) => [e.neg_risk, e.neg_risk_augmented])).toEqual(raw.map((e) => [e.negRisk === true, e.negRiskAugmented === true]));
    const nr = evs.find((e) => e.neg_risk)!;
    expect(nr.markets.length).toBeGreaterThan(1);
    for (const m of nr.markets) {
      expect(m.event_id).toBe(nr.id);
      expect(m.neg_risk).toBe(true);
      expect(m.neg_risk_augmented).toBe(true);
      expect(m.neg_risk_group).toMatch(/^0x[0-9a-f]{64}$/); // negRiskMarketID, shared by the siblings
    }
    expect(new Set(nr.markets.map((m) => m.neg_risk_group)).size).toBe(1);
    expect(nr.markets.every((m) => m.tags.length > 0)).toBe(true);
    route(/\/events\/1038648$/, raw[0]);
    expect((await pm.event("1038648"))!.markets).toHaveLength(3);
  });
  it("resolved markets expose uma_status, closed_time and a settled outcome price", async () => {
    route(/\/markets\/keyset/, () => (urls.length === 1 ? fx("gamma-resolved.json") : { markets: [] }));
    const ms = await pm.listMarkets({ closed: true });
    expect(ms).toHaveLength(2);
    for (const m of ms) {
      expect(m.closed).toBe(true);
      expect(m.open).toBe(false);
      expect(m.uma_status).toBe("resolved");
      expect(m.closed_time).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(m.outcome_prices.some((p) => p >= 0.99)).toBe(true);
    }
  });
  it("toIso accepts Gamma's two timestamp spellings", () => {
    expect(toIso("2026-10-20 13:05:04.275395+00")).toBe("2026-10-20T13:05:04.275Z");
    expect(toIso("2026-10-20T17:45:00Z")).toBe("2026-10-20T17:45:00.000Z");
    expect(toIso("not a date")).toBeUndefined();
    expect(toIso("")).toBeUndefined();
  });
});

describe("clob", () => {
  it("book: numbers, bids best-first (desc), asks best-first (asc); 404 -> undefined", async () => {
    const raw = fx("clob-book.json");
    expect(Number(raw.bids[0].price)).toBeLessThan(Number(raw.bids.at(-1).price)); // wire order is worst-first
    route(/\/book\?/, raw);
    const b = (await pm.book(T))!;
    expect(q().get("token_id")).toBe(T);
    expect(b.token_id).toBe(T);
    expect(b.condition_id).toBe(C);
    expect(b.timestamp).toBeGreaterThan(1.6e12); // ms
    expect(b.tick_size).toBe(0.001);
    expect(b.min_order_size).toBe(5);
    for (let i = 1; i < b.bids.length; i++) expect(b.bids[i]!.price).toBeLessThan(b.bids[i - 1]!.price);
    for (let i = 1; i < b.asks.length; i++) expect(b.asks[i]!.price).toBeGreaterThan(b.asks[i - 1]!.price);
    expect(b.bids[0]!.price).toBeLessThan(b.asks[0]!.price);
    routes = [];
    route(/\/book\?/, () => new Response('{"error":"No orderbook exists for the requested token id"}', { status: 404 }));
    expect(await pm.book("1")).toBeUndefined();
  });
  it("books: POST /books in chunks of 500, deduped, normalised", async () => {
    route(/\/books$/, fx("clob-books.json"));
    const out = await pm.books([...Array.from({ length: 501 }, (_, i) => String(i)), "0"]);
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as unknown[]).length).toBe(500);
    expect(bodies[0]).toEqual(Array.from({ length: 500 }, (_, i) => ({ token_id: String(i) })));
    expect(out).toHaveLength(4); // 2 per mocked call
    expect(out[0]!.bids[0]!.price).toBeGreaterThan(out[0]!.bids[1]!.price);
  });
  it("midpoints: token -> number map", async () => {
    route(/\/midpoints$/, fx("clob-midpoints.json"));
    const mids = await pm.midpoints(meta.tokens);
    expect(Object.keys(mids).sort()).toEqual([...meta.tokens].sort());
    expect(Object.values(mids).every((v) => typeof v === "number")).toBe(true);
  });
  it("pricesHistory: seconds + numeric price; interval vs startTs/endTs query", async () => {
    route(/\/prices-history/, fx("clob-prices-history.json"));
    const h = await pm.pricesHistory({ token: T, interval: "1w", fidelity: 60 });
    expect(q().get("market")).toBe(T);
    expect(q().get("interval")).toBe("1w");
    expect(q().get("fidelity")).toBe("60");
    expect(h.length).toBeGreaterThan(5);
    expect(h[0]!.t).toBeGreaterThan(1.6e9);
    expect(h[0]!.t).toBeLessThan(1e11); // seconds, not ms
    expect(h[0]!.p).toBeGreaterThan(0);
    for (let i = 1; i < h.length; i++) expect(h[i]!.t).toBeGreaterThan(h[i - 1]!.t);
    await pm.pricesHistory({ token: T, startTs: 1, endTs: 2, fidelity: 5 });
    expect(q(1).get("startTs")).toBe("1");
    expect(q(1).get("endTs")).toBe("2");
    expect(q(1).has("interval")).toBe(false);
  });
  it("clobMarket: order rules, tokens, and the fee curve only when the CLOB sends `fd`", async () => {
    route(/\/clob-markets\//, fx("clob-market-info.json"));
    const i = (await pm.clobMarket(C))!;
    expect(urls[0]!.pathname).toBe(`/clob-markets/${C}`);
    expect(i.tokens.map((t) => t.token_id)).toEqual(meta.tokens);
    expect(i.tokens[0]!.outcome).toBe("Yes");
    expect(i.tick_size).toBe(0.001);
    expect(i.min_order_size).toBe(5);
    expect(i.accepting_orders).toBe(true);
    expect(i.fee_schedule).toBeUndefined(); // fee-free market
    routes = [];
    route(/\/clob-markets\//, fx("clob-market-info-fee.json"));
    const f = (await pm.clobMarket("0x1"))!;
    expect(f.fee_schedule).toEqual({ rate: 0.05, exponent: 1, taker_only: true });
    expect(f.taker_base_fee_bps).toBe(1000); // legacy field, not the curve
    routes = [];
    route(/\/clob-markets\//, () => new Response("{}", { status: 404 }));
    expect(await pm.clobMarket("0xnope")).toBeUndefined();
  });
});

describe("data api v2", () => {
  it("holders: per-token {wallet, amount, outcome_index}, amount descending", async () => {
    route(/\/v2\/holders/, fx("data-holders.json"));
    const hs = await pm.holders([C], 5);
    expect(urls[0]!.pathname).toBe("/v2/holders");
    expect(q().get("condition")).toBe(C);
    expect(q().get("limit")).toBe("5");
    expect(hs.map((g) => g.token_id).sort()).toEqual([...meta.tokens].sort());
    const h = hs[0]!.holders;
    expect(h.length).toBeGreaterThan(1);
    expect(h[0]!.wallet).toMatch(/^0x[0-9a-f]{40}$/);
    expect(h[0]!.amount).toBeGreaterThanOrEqual(h[1]!.amount);
    expect(h[0]!.outcome_index).toBe(0);
    expect(h[0]!.name).toBeTypeOf("string");
  });
  it("trades: normalised newest-first rows; selectors sent", async () => {
    route(/\/v2\/trades/, fx("data-trades.json"));
    const ts = await pm.trades({ market: [C], limit: 6 });
    expect(urls[0]!.pathname).toBe("/v2/trades");
    expect(q().get("condition")).toBe(C);
    expect(q().get("limit")).toBe("6");
    expect(q().has("taker_only")).toBe(false);
    expect(ts).toHaveLength(6);
    for (const t of ts) {
      expect(["BUY", "SELL"]).toContain(t.side);
      expect(t.size).toBeGreaterThan(0);
      expect(t.price).toBeGreaterThan(0);
      expect(t.price).toBeLessThanOrEqual(1);
      expect(t.ts).toBeGreaterThan(1.6e9);
      expect(t.ts).toBeLessThan(1e11); // seconds
      expect(t.token_id).toMatch(/^\d+$/);
      expect(t.condition_id).toBe(C);
      expect(["Yes", "No"]).toContain(t.outcome);
      expect(t.outcome_index).toBeTypeOf("number");
      expect(t.wallet).toMatch(/^0x[0-9a-f]{40}$/);
      expect(t.tx).toMatch(/^0x[0-9a-f]{64}$/);
    }
    for (let i = 1; i < ts.length; i++) expect(ts[i]!.ts).toBeLessThanOrEqual(ts[i - 1]!.ts);
  });
  it("trades: `since` stops paging; otherwise the cursor is followed and every page repeats the selectors", async () => {
    const page = fx("data-trades.json");
    const all = page.data as { timestamp: number }[];
    const cut = all[2]!.timestamp;
    route(/\/v2\/trades/, page);
    const recent = await pm.trades({ market: [C], limit: 1000, since: cut });
    expect(recent.every((t) => t.ts >= cut)).toBe(true);
    expect(recent.length).toBeLessThan(all.length);
    expect(urls).toHaveLength(1);
    urls = [];
    routes = [];
    route(/\/v2\/trades/, () => ({ data: all, pagination: { has_more: urls.length < 2, next_cursor: urls.length < 2 ? "C2" : null } }));
    const two = await pm.trades({ market: [C], limit: 1000, takerOnly: false });
    expect(two).toHaveLength(all.length * 2);
    for (const u of urls) {
      expect(u.searchParams.get("condition")).toBe(C);
      expect(u.searchParams.get("limit")).toBe("1000");
      expect(u.searchParams.get("taker_only")).toBe("false");
    }
    expect(q(0).has("cursor")).toBe(false);
    expect(q(1).get("cursor")).toBe("C2");
  });
  it("oi: condition -> USDC", async () => {
    route(/\/v2\/oi/, fx("data-oi.json"));
    const oi = await pm.oi([C]);
    expect(q().get("condition")).toBe(C);
    expect(oi).toEqual({ [C]: expect.any(Number) });
  });
  it("v1 shapes (bare camelCase arrays) still normalise to the same output", () => {
    expect(normHolders([{ token: "t", holders: [{ proxyWallet: "0xa", amount: "5", outcomeIndex: 1 }] }])).toEqual([{ token_id: "t", holders: [{ wallet: "0xa", amount: 5, outcome_index: 1, name: undefined }] }]);
    expect(normOi([{ market: "0xc", value: "12.5" }])).toEqual({ "0xc": 12.5 });
    expect(normTrades([{ side: "buy", size: "3", price: "0.4", timestamp: 1, asset: "t", conditionId: "0xc", transactionHash: "0xh", proxyWallet: "0xw" }])).toEqual([
      { side: "BUY", size: 3, price: 0.4, ts: 1, token_id: "t", condition_id: "0xc", outcome: undefined, outcome_index: undefined, tx: "0xh", wallet: "0xw" },
    ]);
    expect(normTrades({ data: [{ side: "SELL", size: 1 }] })).toEqual([]); // no price/timestamp -> dropped, never thrown
  });
});

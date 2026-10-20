import { afterEach, describe, expect, it, vi } from "vitest";
import { bucket } from "./bucket";
import { createPm } from "./index";
import { normMarket } from "./schemas";

afterEach(() => vi.useRealTimers());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("token bucket", () => {
  it("delays instead of rejecting when exhausted", async () => {
    vi.useFakeTimers();
    const take = bucket(2, 1000); // 1 token / 500 ms
    await take();
    await take();
    let done = false;
    const third = take().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(third).resolves.toBe(true);
  });
});

describe("fetch wrapper", () => {
  it("retries 429/5xx with backoff, then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ base_fee: "400" }));
    const sleeps: number[] = [];
    const pm = createPm({ fixtures: false, fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(await pm.feeRateBps("1")).toBe(400);
    expect(f).toHaveBeenCalledTimes(3);
    // 429: 5 s ban, then one clob refill interval (20 ms: a ban earns no tokens); 503: plain backoff. The injected sleep does not move the
    // clock, so the last attempt waits for refill tokens; how long depends on real time elapsed, so only its bound is fixed.
    expect(sleeps.slice(0, 3)).toEqual([5000, 20, 500]);
    expect(sleeps.slice(3).every((ms) => ms >= 0 && ms <= 40)).toBe(true);
    expect(sleeps.length).toBeLessThanOrEqual(4);
  });
  it("caps retry-after at 30s", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "999" } })).mockResolvedValueOnce(json({ base_fee: "1" }));
    const sleeps: number[] = [];
    await createPm({ fixtures: false, fetch: f, sleep: async (ms) => void sleeps.push(ms) }).feeRateBps("1");
    expect(sleeps[0]).toBe(30_000);
    expect(sleeps.slice(1).every((ms) => ms >= 0 && ms <= 20)).toBe(true); // refill wait shrinks with real time elapsed
  });
  it("gives up after 3 retries and does not retry 4xx", async () => {
    const f = vi.fn().mockResolvedValue(json({}, 500));
    const pm = createPm({ fixtures: false, fetch: f, sleep: async () => {} });
    await expect(pm.tickSize("1")).rejects.toThrow(/500/);
    expect(f).toHaveBeenCalledTimes(4);
    const g = vi.fn().mockResolvedValue(json({ error: "bad" }, 422));
    await expect(createPm({ fixtures: false, fetch: g, sleep: async () => {} }).tickSize("1")).rejects.toThrow(/422/);
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("pagination", () => {
  it("walks keyset cursors to the end", async () => {
    const m = (n: number) => ({ id: String(n), conditionId: `0x${n}`, question: `q${n}` });
    const pages: Record<string, unknown> = {
      "": { markets: [m(1), m(2)], next_cursor: "c1" },
      c1: { markets: [m(3), m(4)], next_cursor: "c2" },
      c2: { markets: [m(5)] },
    };
    const f = vi.fn(async (u: URL) => json(pages[u.searchParams.get("after_cursor") ?? ""]));
    const out = await createPm({ fixtures: false, fetch: f as never }).listMarkets();
    expect(out.map((x) => x.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(String(f.mock.calls[0]![0])).toContain("closed=false");
  });
  it("sends the server-side universe filters", async () => {
    const f = vi.fn(async () => json({ markets: [] }));
    await createPm({ fixtures: false, fetch: f as never }).listMarkets({ liquidityMin: 1000, endDateMin: "2026-01-03T00:00:00.000Z", endDateMax: "2026-05-01T00:00:00.000Z" });
    const q = new URL(String((f.mock.calls[0] as unknown[])[0])).searchParams;
    expect([q.get("closed"), q.get("liquidity_num_min"), q.get("end_date_min"), q.get("end_date_max")]).toEqual(["false", "1000", "2026-01-03T00:00:00.000Z", "2026-05-01T00:00:00.000Z"]);
  });
  it("walkMarkets streams pages and stops cleanly (complete=false) on a persistent 429", async () => {
    const m = (n: number) => ({ id: String(n), conditionId: `0x${n}`, question: `q${n}` });
    const f = vi.fn()
      .mockResolvedValueOnce(json({ markets: [m(1), m(2)], next_cursor: "c1" }))
      .mockResolvedValue(new Response("1015", { status: 429, headers: { "retry-after": "2" } }));
    const sleeps: number[] = [];
    const got: string[][] = [];
    const r = await createPm({ fixtures: false, fetch: f as never, sleep: async (ms) => void sleeps.push(ms) }).walkMarkets({}, (ms) => void got.push(ms.map((x) => x.id)));
    expect(got).toEqual([["1", "2"]]);
    expect(r).toEqual({ pages: 1, complete: false });
    // page gap, then one wait floored at 5 s plus at most a gamma refill interval (shorter when real time has passed); no hammering
    expect(sleeps.slice(0, 2)).toEqual([100, 5000]);
    expect(sleeps.slice(2).every((ms) => ms >= 0 && ms <= 34)).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("walkMarkets: budget exhausted -> complete=false after the page in flight", async () => {
    const f = vi.fn(async () => json({ markets: [{ id: "1", conditionId: "0x1", question: "q" }], next_cursor: `c${Math.random()}` }));
    const r = await createPm({ fixtures: false, fetch: f as never, sleep: async () => {} }).walkMarkets({ budgetMs: -1 }, () => {});
    expect(r).toEqual({ pages: 1, complete: false });
  });
  it("429 waits at least 5 s even with Retry-After: 0", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } })).mockResolvedValueOnce(json({ base_fee: "1" }));
    const sleeps: number[] = [];
    await createPm({ fixtures: false, fetch: f, sleep: async (ms) => void sleeps.push(ms) }).feeRateBps("1");
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000);
  });
  it("stops on a repeated cursor (API quirk)", async () => {
    const f = vi.fn(async () => json({ markets: [{ id: "1", conditionId: "0x1", question: "q" }], next_cursor: "same" }));
    expect(await createPm({ fixtures: false, fetch: f as never }).listMarkets()).toHaveLength(2);
  });
});

describe("lenient parsing", () => {
  it("coerces numeric strings and JSON-string arrays, tolerates junk", () => {
    const m = normMarket({
      id: 123, question: "Q?", conditionId: "0xabc", volume: "3512.5", liquidity: "oops", lastTradePrice: "0.21",
      outcomes: '["No","Yes"]', outcomePrices: '["0.7","0.3"]', clobTokenIds: '["tn","ty"]', negRisk: "true",
      endDate: "2026-12-31T00:00:00Z", futureField: { a: 1 }, events: [{ id: 9, tags: [{ slug: "crypto" }, 5] }],
    })!;
    expect(m).toMatchObject({ id: "123", volume: 3512.5, liquidity: undefined, last_trade_price: 0.21, yes_token_id: "ty", no_token_id: "tn", yes_price: 0.3, neg_risk: true, neg_risk_group: "9", category: "crypto", event_id: "9", end_date: "2026-12-31T00:00:00.000Z" });
    expect(normMarket({ question: "no condition" })).toBeUndefined();
  });
  it("sorts books best-first and accepts both map and array token shapes", async () => {
    const f = vi.fn(async (u: URL) => json(String(u).includes("/books")
      ? [{ asset_id: "t", bids: [{ price: "0.40", size: "5" }, { price: "0.45", size: "9" }], asks: [{ price: "0.60", size: "1" }, { price: "0.50", size: "2" }] }]
      : [{ token_id: "t", mid: "0.5" }]));
    const pm = createPm({ fixtures: false, fetch: f as never });
    const [b] = await pm.books(["t"]);
    expect(b!.bids[0]!.price).toBe(0.45);
    expect(b!.asks[0]!.price).toBe(0.5);
    expect(await pm.midpoints(["t"])).toEqual({ t: 0.5 });
  });
});

describe("POST /books chunking", () => {
  it("splits into chunks of at most 500 tokens and dedupes", async () => {
    const f = vi.fn(async (_u: URL, init: RequestInit) => json(JSON.parse(init.body as string).map((b: { token_id: string }) => ({ asset_id: b.token_id, bids: [], asks: [] }))));
    const tokens = Array.from({ length: 1201 }, (_, i) => String(i));
    const books = await createPm({ fixtures: false, fetch: f as never }).books([...tokens, "0"]);
    const sizes = f.mock.calls.map((c) => JSON.parse(c[1].body as string).length);
    expect(sizes).toEqual([500, 500, 201]);
    expect(books).toHaveLength(1201);
    expect(f.mock.calls[0]![1].method).toBe("POST");
  });
});

describe("fixture client", () => {
  const pm = createPm({ fixtures: true });
  it("returns the full universe via cursor pagination", async () => {
    const ms = await pm.listMarkets({ closed: false, limit: 7 });
    expect(ms).toHaveLength(39); // 40 minus the closed one
    expect(new Set(ms.map((m) => m.condition_id)).size).toBe(39);
    const rawAll = (await pm.raw("gamma", "/markets/keyset", { params: { limit: 100 } })) as { markets: unknown[] };
    expect(rawAll.markets).toHaveLength(40);
    const evs = await pm.listEvents();
    expect(evs.flatMap((e) => e.markets)).toHaveLength(39);
  });
  it("neg-risk group A is an arb: sum of best asks + fees < 1", async () => {
    const a = (await pm.listMarkets()).filter((m) => m.question.startsWith("Fed "));
    expect(new Set(a.map((m) => m.neg_risk_group)).size).toBe(1);
    expect(a).toHaveLength(4);
    const books = await pm.books(a.map((m) => m.yes_token_id!));
    const asks = books.map((b) => b.asks[0]!.price);
    const fees = asks.reduce((s, p) => s + 0.04 * p * (1 - p), 0);
    expect(asks.reduce((s, p) => s + p, 0) + fees).toBeLessThan(1);
  });
  it("serves books, comments, holders, trades, oi, history, fee, tick, dispute", async () => {
    const all = await pm.listMarkets();
    const l2 = all.find((m) => m.question.includes("January 31, 2027"))!;
    const l3 = all.find((m) => m.question.includes("March 31, 2027"))!;
    expect(l2.yes_price!).toBeGreaterThan(l3.yes_price!); // ladder violation
    expect(all.filter((m) => m.in_dispute)).toHaveLength(1);
    expect((await pm.comments({ entityId: l2.event_id! })).length).toBeGreaterThan(0);
    expect((await pm.holders([l2.condition_id]))[0]!.holders.length).toBeGreaterThan(0);
    expect((await pm.trades({ market: [l2.condition_id] })).length).toBeGreaterThan(0);
    expect(Object.keys(await pm.oi([l2.condition_id]))).toEqual([l2.condition_id]);
    expect((await pm.pricesHistory({ token: l2.yes_token_id!, interval: "1w" })).length).toBeGreaterThan(10);
    expect((await pm.clobMarket(l2.condition_id))!.tokens.map((t) => t.token_id)).toContain(l2.yes_token_id);
    expect((await pm.book(l2.yes_token_id!))!.token_id).toBe(l2.yes_token_id);
    expect(await pm.book("no-such-token")).toBeUndefined();
    expect(await pm.feeRateBps(l2.yes_token_id!)).toBe(700);
    expect(await pm.tickSize(l2.yes_token_id!)).toBe(0.01);
    expect(Object.keys(await pm.spreads([l2.yes_token_id!]))).toHaveLength(1);
    expect((await pm.market(l2.id))!.condition_id).toBe(l2.condition_id);
  });
  it("rejects oversized batches like the real API", async () => {
    await expect(createPm({ fixtures: true }).raw("clob", "/books", { body: Array.from({ length: 501 }, (_, i) => ({ token_id: String(i) })) })).rejects.toThrow(/500/);
  });
  it("network failures after retries are marked like HTTP failures", async () => {
    const pm = createPm({ fixtures: false, fetch: (async () => { throw new TypeError("fetch failed"); }) as never, sleep: async () => {} });
    await expect(pm.oi(["0x1"])).rejects.toThrow(/^GET \/v2\/oi -> network fetch failed/);
  });
});

describe("searchMarkets", () => {
  it("returns open markets matching the query, deduped and capped (fixtures)", async () => {
    const pm = createPm({ fixtures: true });
    const ms = await pm.searchMarkets("fed", 3);
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.length).toBeLessThanOrEqual(3);
    expect(ms.every((m) => m.open && m.accepting_orders && m.condition_id)).toBe(true);
    expect(await pm.searchMarkets("zzzz-no-such-market")).toEqual([]);
  });
  it("returns at most 3 markets per event", async () => {
    const mk = (id: string) => ({ id, conditionId: `0x${id}`, question: `Q${id}`, active: true, closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' });
    const f = vi.fn().mockResolvedValue(json({ events: [{ id: "big", markets: ["1", "2", "3", "4", "5"].map(mk) }, { id: "e2", markets: [mk("9")] }] }));
    expect((await createPm({ fixtures: false, fetch: f }).searchMarkets("x")).map((m) => m.id)).toEqual(["1", "2", "3", "9"]);
  });
  it("drops closed and non-accepting markets from a live-shaped response", async () => {
    const mk = (id: string, extra: object) => ({ id, conditionId: `0x${id}`, question: `Q${id}`, active: true, closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', ...extra });
    const f = vi.fn().mockResolvedValue(json({ events: [{ id: "e1", markets: [mk("1", {}), mk("2", { closed: true }), mk("3", { acceptingOrders: false }), mk("1", {})] }, null] }));
    const ms = await createPm({ fixtures: false, fetch: f }).searchMarkets("x");
    expect(ms.map((m) => m.id)).toEqual(["1"]);
    const u = new URL(f.mock.calls[0]![0]);
    expect(u.pathname).toBe("/public-search");
    expect(u.searchParams.get("q")).toBe("x");
  });
});

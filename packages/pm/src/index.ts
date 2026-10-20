import { bucket, type Take } from "./bucket";
import { fixtureCall, type Host, type Req } from "./fixtures";
import {
  normBook, normClobMarket, normComments, normEvent, normHistory, normHolders, normMarket, normOi, normTokenMap, normTrades,
  toNum, type Book, type ClobMarketInfo, type Comment, type HistoryPoint, type HolderGroup, type Market, type PmEvent, type Trade,
} from "./schemas";

export * from "./schemas";
export { bucket, type BucketOpts, type Take } from "./bucket";
export * from "./exchange";

const BASE: Record<Host, string> = {
  gamma: "https://gamma-api.polymarket.com",
  clob: "https://clob.polymarket.com",
  data: "https://data-api.polymarket.com",
};
// req / 10 s: tightest documented route per host (SPEC table): gamma /markets 300, clob batch 500, data /trades 200
const LIMIT: Record<Host, number> = { gamma: 300, clob: 500, data: 200 };
const WINDOW_MS = 10_000;
const BURST_DIV = 5; // idle burst = 1/5 of the window: a 25-chunk fan-out is paced, not fired at once (Cloudflare 1015 trips on spikes)
const MAX_RETRIES = 3;
const MAX_PER_EVENT = 3;
const BATCH = 500;
const MIN_429_MS = 5_000; // Cloudflare 1015 bans for seconds, not ms: never retry a 429 faster than 5 s
const MAX_RETRY_AFTER_MS = 30_000;
const PAGE_GAP_MS = 100; // keyset pacing: <= 10 req/s, far below the documented gamma limit but Cloudflare 1015 trips on bursts
const TRADES_PAGE = 1000; // Data API v2 max per page

export type PmOptions = {
  /** Serve every call from packages/pm/fixtures. Default: env PM_FIXTURES=1. */
  fixtures?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export type HistoryInterval = "max" | "all" | "1m" | "1w" | "1d" | "6h" | "1h";
/** Either a named `interval` (ending now) or an explicit `startTs`/`endTs` window (unix seconds). `fidelity` = bucket size in minutes. */
export type HistoryQuery = { token: string; fidelity?: number } & ({ interval: HistoryInterval; startTs?: never; endTs?: never } | { interval?: never; startTs: number; endTs?: number });
export type TradesQuery = {
  /** condition ids (comma-joined server side; omitted = global feed) */
  market?: string[];
  /** max rows returned (default 100) */
  limit?: number;
  /** unix seconds; paging stops once rows older than this are reached (the feed is newest-first) */
  since?: number;
  /** default true: one row per fill from the taker's view (set false for maker rows too) */
  takerOnly?: boolean;
};

const chunks = <T>(xs: T[], n = BATCH) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const retryAfterMs = (res: Response): number | undefined => {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = toNum(h);
  if (secs !== undefined) return secs * 1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
};

type MarketQuery = { closed?: boolean; limit?: number; liquidityMin?: number; endDateMin?: string; endDateMax?: string };
const marketParams = (o: MarketQuery) => ({ closed: o.closed ?? false, limit: o.limit, liquidity_num_min: o.liquidityMin, end_date_min: o.endDateMin, end_date_max: o.endDateMax });
type EventQuery = { closed?: boolean; limit?: number; tagId?: number; tagSlug?: string; liquidityMin?: number };

export function createPm(opts: PmOptions = {}) {
  const fixtures = opts.fixtures ?? process.env.PM_FIXTURES === "1";
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mk = (h: Host) => bucket(LIMIT[h], WINDOW_MS, { burst: LIMIT[h] / BURST_DIV, sleep });
  const take: Record<Host, Take> = { gamma: mk("gamma"), clob: mk("clob"), data: mk("data") };

  /**
   * Raw JSON call. Throttled (delayed, never rejected), retried on 429/5xx/network error (max 3), timed out.
   * A 429 penalizes the host bucket (Retry-After or >= 5 s), so every concurrent caller on that host waits, not just this one.
   * Errors are `"<METHOD> <path> -> <status|network> ..."` so callers can tell a venue failure from a bug.
   */
  async function raw(host: Host, path: string, req: Req = {}): Promise<unknown> {
    if (fixtures) return fixtureCall(host, path, req);
    const url = new URL(BASE[host] + path);
    for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const post = req.body !== undefined, retries = req.retries ?? MAX_RETRIES;
    const tag = `${post ? "POST" : "GET"} ${url.pathname}`;
    for (let attempt = 0; ; attempt++) {
      await take[host]();
      const backoff = 250 * 2 ** attempt;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: post ? "POST" : "GET",
          headers: post ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
          body: post ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (e) {
        if (attempt >= retries) throw new Error(`${tag} -> network ${(e as Error)?.message ?? e}`, { cause: e });
        await sleep(backoff);
        continue;
      }
      if (res.ok) return res.json().catch((e: unknown) => { throw new Error(`${tag} -> network bad body ${(e as Error)?.message ?? e}`, { cause: e }); });
      // penalize even on the last attempt: the next caller on this host (e.g. the sweep's next chunk) must still wait out the ban
      if (res.status === 429) take[host].penalize(Math.max(MIN_429_MS, Math.min(retryAfterMs(res) ?? backoff, MAX_RETRY_AFTER_MS)));
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        if (res.status !== 429) await sleep(backoff);
        continue;
      }
      throw new Error(`${tag} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
  /** undefined on 404 (CLOB: "No orderbook exists", unknown condition); other failures throw. */
  const orUndefined = async <T>(p: Promise<T>): Promise<T | undefined> => p.catch((e) => { if (/(-> 404 |^fixture 404)/.test(String((e as Error)?.message))) return undefined; throw e; });

  /**
   * Walks keyset cursors one page at a time, handing each page to `onPage` (nothing is accumulated).
   * Stops on empty page, missing cursor, or a repeated cursor (known API quirk) => complete.
   * Stops early (complete=false, no throw) on a 429 / 5xx / network error that survived one retry, or when `budgetMs` is spent: the caller keeps what it got.
   * Other errors (4xx, bad body) throw. ponytail: no resume cursor, a cut-short walk restarts from page 1 next sweep; persist the cursor if the universe outgrows one run. Pages are paced `PAGE_GAP_MS` apart.
   */
  async function keyset<T>(path: string, key: string, params: Req["params"], norm: (x: unknown) => T | undefined, onPage: (xs: T[]) => Promise<void> | void, budgetMs = Infinity) {
    const seen = new Set<string>();
    const t0 = Date.now();
    let cursor: string | undefined, pages = 0;
    for (;;) {
      if (pages && Date.now() - t0 > budgetMs) return { pages, complete: false };
      let r: any;
      try {
        r = await raw("gamma", path, { params: { ...params, limit: params?.limit ?? 100, after_cursor: cursor }, retries: 1 });
      } catch (e) {
        if (/-> (429|5\d\d|network) /.test(String((e as Error)?.message))) return { pages, complete: false };
        throw e;
      }
      pages++;
      const items: unknown[] = Array.isArray(r) ? r : r?.[key] ?? [];
      await onPage(items.flatMap((x) => norm(x) ?? []));
      const next: unknown = Array.isArray(r) ? undefined : r?.next_cursor;
      if (!items.length || typeof next !== "string" || !next || seen.has(next)) return { pages, complete: true };
      seen.add(next);
      cursor = next;
      if (!fixtures) await sleep(PAGE_GAP_MS);
    }
  }
  const collect = async <T>(path: string, key: string, params: Req["params"], norm: (x: unknown) => T | undefined): Promise<T[]> => {
    const out: T[] = [];
    await keyset(path, key, params, norm, (xs) => void out.push(...xs));
    return out;
  };

  /** One failed chunk does not fail the batch: returns what succeeded (throws only if every chunk failed). */
  const batch = async <T>(path: string, tokens: string[], norm: (r: unknown) => T): Promise<T[]> => {
    const rs = await Promise.allSettled(chunks([...new Set(tokens)]).map((c) => raw("clob", path, { body: c.map((token_id) => ({ token_id })) }).then(norm)));
    const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const bad = rs.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (bad && !ok.length) throw bad.reason;
    return ok;
  };

  return {
    raw,
    // Gamma
    listMarkets: (o: MarketQuery = {}): Promise<Market[]> => collect("/markets/keyset", "markets", marketParams(o), (x) => normMarket(x)),
    /** Streams the (filtered) market listing page by page. `complete` is false when a 429 or `budgetMs` cut it short: the pages already delivered are valid. */
    walkMarkets: (o: MarketQuery & { budgetMs?: number }, onPage: (ms: Market[]) => Promise<void> | void) =>
      keyset("/markets/keyset", "markets", marketParams(o), (x) => normMarket(x), onPage, o.budgetMs),
    /** Events with nested markets (neg-risk siblings share one event; see `neg_risk` / `neg_risk_augmented`). */
    listEvents: (o: EventQuery = {}): Promise<PmEvent[]> =>
      collect("/events/keyset", "events", { closed: o.closed ?? false, limit: o.limit, tag_id: o.tagId, tag_slug: o.tagSlug, liquidity_min: o.liquidityMin }, normEvent),
    event: async (id: string): Promise<PmEvent | undefined> => normEvent(await raw("gamma", `/events/${encodeURIComponent(id)}`)),
    market: async (id: string): Promise<Market | undefined> => normMarket(await raw("gamma", `/markets/${encodeURIComponent(id)}`)),
    /** Open, order-accepting markets matching free text (Gamma /public-search, events -> nested markets). One call, no retry storm. */
    searchMarkets: async (q: string, limit = 10): Promise<Market[]> => {
      const r: any = await raw("gamma", "/public-search", { params: { q, limit_per_type: limit, events_status: "active", keep_closed_markets: 0 }, retries: 1 });
      const out = new Map<string, Market>();
      for (const e of Array.isArray(r?.events) ? r.events : []) {
        const ms = (normEvent(e)?.markets ?? []).filter((m) => m.open && m.accepting_orders).slice(0, MAX_PER_EVENT); // one multi-outcome event must not fill the list
        for (const m of ms) out.set(m.condition_id, m);
      }
      return [...out.values()].slice(0, limit);
    },
    comments: async (o: { entityType?: string; entityId: string | number; limit?: number }): Promise<Comment[]> =>
      normComments(await raw("gamma", "/comments", { params: { parent_entity_type: o.entityType ?? "Event", parent_entity_id: o.entityId, limit: o.limit ?? 50 } })),
    // CLOB (batch endpoints chunk at 500 tokens; tokens without a book are simply absent)
    books: async (tokens: string[]): Promise<Book[]> => (await batch("/books", tokens, (r) => (Array.isArray(r) ? r : []).flatMap((b) => normBook(b) ?? []))).flat(),
    /** One book; undefined when the venue has none for the token (404). */
    book: async (token: string): Promise<Book | undefined> => normBook(await orUndefined(raw("clob", "/book", { params: { token_id: token } }))),
    midpoints: async (tokens: string[]) => Object.assign({}, ...(await batch("/midpoints", tokens, (r) => normTokenMap(r, ["mid", "value"])))) as Record<string, number>,
    spreads: async (tokens: string[]) => Object.assign({}, ...(await batch("/spreads", tokens, (r) => normTokenMap(r, ["spread", "value"])))) as Record<string, number>,
    lastTradePrices: async (tokens: string[]) => Object.assign({}, ...(await batch("/last-trades-prices", tokens, (r) => normTokenMap(r, ["price", "value"])))) as Record<string, number>,
    /** Price series for one token (unix seconds, price). Chart timeframes: `{interval:"1d", fidelity:5}`, `{interval:"1w", fidelity:60}`, `{interval:"max", fidelity:1440}`. */
    pricesHistory: async (o: HistoryQuery): Promise<HistoryPoint[]> =>
      normHistory(await raw("clob", "/prices-history", { params: { market: o.token, interval: o.interval, fidelity: o.fidelity, startTs: o.startTs, endTs: o.endTs } })),
    /** Venue order rules + authoritative fee curve for a condition; undefined when the CLOB does not know it. */
    clobMarket: async (conditionId: string): Promise<ClobMarketInfo | undefined> => normClobMarket(await orUndefined(raw("clob", `/clob-markets/${encodeURIComponent(conditionId)}`))),
    /** LEGACY raw `base_fee` (bps). Does not reflect the fee curve: prefer `Market.fee_schedule` (Gamma) or `clobMarket().fee_schedule`. */
    feeRateBps: async (token: string): Promise<number | undefined> => toNum(((await raw("clob", "/fee-rate", { params: { token_id: token } })) as any)?.base_fee),
    tickSize: async (token: string): Promise<number | undefined> => toNum(((await raw("clob", "/tick-size", { params: { token_id: token } })) as any)?.minimum_tick_size),
    // Data API v2 (v1 `?market=` bare arrays retire 2026-10-24)
    /** Top `limit` holders per outcome token (amount = shares, descending as served). Enough for HHI / top-1 / top-5 concentration. */
    holders: async (conditionIds: string[], limit = 20): Promise<HolderGroup[]> => normHolders(await raw("data", "/v2/holders", { params: { condition: conditionIds.join(","), limit } })),
    oi: async (conditionIds: string[]) => normOi(await raw("data", "/v2/oi", { params: { condition: conditionIds.join(",") } })),
    /**
     * Newest-first fills, cursor-paged until `limit` rows or `since`. Each page repeats the selectors: the cursor does not encode
     * the market, so a bare cursor would silently continue with the global stream.
     */
    trades: async (o: TradesQuery = {}): Promise<Trade[]> => {
      const max = o.limit ?? 100, out: Trade[] = [];
      let cursor: string | undefined;
      while (out.length < max) {
        const r: any = await raw("data", "/v2/trades", { params: { condition: o.market?.join(","), limit: Math.min(max, TRADES_PAGE), taker_only: o.takerOnly === false ? "false" : undefined, cursor } });
        const page = normTrades(r);
        const fresh = o.since === undefined ? page : page.filter((t) => t.ts >= o.since!);
        out.push(...fresh);
        const next = r?.pagination?.has_more === false ? undefined : r?.pagination?.next_cursor;
        if (!page.length || fresh.length < page.length || typeof next !== "string" || !next) break;
        cursor = next;
      }
      return out.slice(0, max);
    },
  };
}

export type Pm = ReturnType<typeof createPm>;

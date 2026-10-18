import { bucket } from "./bucket";
import { fixtureCall, type Host, type Req } from "./fixtures";
import {
  normBook, normComments, normEvent, normHistory, normHolders, normMarket, normOi, normTokenMap, normTrades,
  toNum, type Book, type Comment, type HistoryPoint, type HolderGroup, type Market, type PmEvent, type Trade,
} from "./schemas";

export * from "./schemas";
export { bucket } from "./bucket";
export * from "./exchange";

const BASE: Record<Host, string> = {
  gamma: "https://gamma-api.polymarket.com",
  clob: "https://clob.polymarket.com",
  data: "https://data-api.polymarket.com",
};
// req / 10 s: tightest documented route per host (SPEC table): gamma /markets 300, clob batch 500, data /trades 200
const LIMIT: Record<Host, number> = { gamma: 300, clob: 500, data: 200 };
const MAX_RETRIES = 3;
const BATCH = 500;

export type PmOptions = {
  /** Serve every call from packages/pm/fixtures. Default: env PM_FIXTURES=1. */
  fixtures?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const chunks = <T>(xs: T[], n = BATCH) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export function createPm(opts: PmOptions = {}) {
  const fixtures = opts.fixtures ?? process.env.PM_FIXTURES === "1";
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const take: Record<Host, () => Promise<void>> = {
    gamma: bucket(LIMIT.gamma, 10_000), clob: bucket(LIMIT.clob, 10_000), data: bucket(LIMIT.data, 10_000),
  };

  /** Raw JSON call. Throttled (delayed, never rejected), retried on 429/5xx/network error (max 3), timed out. */
  async function raw(host: Host, path: string, req: Req = {}): Promise<unknown> {
    if (fixtures) return fixtureCall(host, path, req);
    const url = new URL(BASE[host] + path);
    for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const post = req.body !== undefined;
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
        // marked like an HTTP failure so callers can tell a venue/network failure from a bug
        if (attempt >= MAX_RETRIES) throw new Error(`${post ? "POST" : "GET"} ${url.pathname} -> network ${(e as Error)?.message ?? e}`, { cause: e });
        await sleep(backoff);
        continue;
      }
      if (res.ok) return res.json().catch((e: unknown) => { throw new Error(`${post ? "POST" : "GET"} ${url.pathname} -> network bad body ${(e as Error)?.message ?? e}`, { cause: e }); });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const ra = toNum(res.headers.get("retry-after"));
        await sleep(ra !== undefined ? Math.min(ra * 1000, 30_000) : backoff);
        continue;
      }
      throw new Error(`${post ? "POST" : "GET"} ${url.pathname} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  /** Walks keyset cursors to the end. Stops on empty page, missing cursor, or a repeated cursor (known API quirk). */
  async function keyset<T>(path: string, key: string, params: Req["params"], norm: (x: unknown) => T | undefined): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const r = (await raw("gamma", path, { params: { ...params, limit: params?.limit ?? 100, after_cursor: cursor } })) as any;
      const items: unknown[] = Array.isArray(r) ? r : r?.[key] ?? [];
      out.push(...items.flatMap((x) => norm(x) ?? []));
      const next: unknown = Array.isArray(r) ? undefined : r?.next_cursor;
      if (!items.length || typeof next !== "string" || !next || seen.has(next)) return out;
      seen.add(next);
      cursor = next;
    }
  }

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
    listMarkets: (o: { closed?: boolean; limit?: number; liquidityMin?: number; endDateMin?: string; endDateMax?: string } = {}): Promise<Market[]> =>
      keyset("/markets/keyset", "markets", { closed: o.closed ?? false, limit: o.limit, liquidity_num_min: o.liquidityMin, end_date_min: o.endDateMin, end_date_max: o.endDateMax }, (x) => normMarket(x)),
    listEvents: (o: { closed?: boolean; limit?: number } = {}): Promise<PmEvent[]> =>
      keyset("/events/keyset", "events", { closed: o.closed ?? false, limit: o.limit }, normEvent),
    event: async (id: string): Promise<PmEvent | undefined> => normEvent(await raw("gamma", `/events/${encodeURIComponent(id)}`)),
    market: async (id: string): Promise<Market | undefined> => normMarket(await raw("gamma", `/markets/${encodeURIComponent(id)}`)),
    comments: async (o: { entityType?: string; entityId: string | number; limit?: number }): Promise<Comment[]> =>
      normComments(await raw("gamma", "/comments", { params: { parent_entity_type: o.entityType ?? "Event", parent_entity_id: o.entityId, limit: o.limit ?? 50 } })),
    // CLOB (batch endpoints chunk at 500 tokens)
    books: async (tokens: string[]): Promise<Book[]> => (await batch("/books", tokens, (r) => (Array.isArray(r) ? r : []).flatMap((b) => normBook(b) ?? []))).flat(),
    midpoints: async (tokens: string[]) => Object.assign({}, ...(await batch("/midpoints", tokens, (r) => normTokenMap(r, ["mid", "value"])))) as Record<string, number>,
    spreads: async (tokens: string[]) => Object.assign({}, ...(await batch("/spreads", tokens, (r) => normTokenMap(r, ["spread", "value"])))) as Record<string, number>,
    lastTradePrices: async (tokens: string[]) => Object.assign({}, ...(await batch("/last-trades-prices", tokens, (r) => normTokenMap(r, ["price", "value"])))) as Record<string, number>,
    pricesHistory: async (o: { token: string; interval?: string; fidelity?: number; startTs?: number; endTs?: number }): Promise<HistoryPoint[]> =>
      normHistory(await raw("clob", "/prices-history", { params: { market: o.token, interval: o.interval, fidelity: o.fidelity, startTs: o.startTs, endTs: o.endTs } })),
    /** raw `base_fee` (basis points per getFeeRateBps; unit unverified) */
    feeRateBps: async (token: string): Promise<number | undefined> => toNum(((await raw("clob", "/fee-rate", { params: { token_id: token } })) as any)?.base_fee),
    tickSize: async (token: string): Promise<number | undefined> => toNum(((await raw("clob", "/tick-size", { params: { token_id: token } })) as any)?.minimum_tick_size),
    // Data API
    holders: async (conditionIds: string[], limit = 20): Promise<HolderGroup[]> => normHolders(await raw("data", "/holders", { params: { market: conditionIds.join(","), limit } })),
    oi: async (conditionIds: string[]) => normOi(await raw("data", "/oi", { params: { market: conditionIds.join(",") } })),
    trades: async (o: { market?: string[]; limit?: number; offset?: number; side?: string; start?: number; end?: number } = {}): Promise<Trade[]> =>
      normTrades(await raw("data", "/trades", { params: { ...o, market: o.market?.join(","), limit: o.limit ?? 100 } })),
  };
}

export type Pm = ReturnType<typeof createPm>;

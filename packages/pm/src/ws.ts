// CLOB market-channel WebSocket client. Browser-safe: no Node imports, only zod + ./schemas.
// Import from "@pm/pm/ws" (the package root pulls node:fs through the fixture server).
import { z } from "zod";
import { normBook, toNum, type Book } from "./schemas";

export const WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// ---- raw frames (strings for every number; the initial dump is a JSON *array* of `book` frames; "PING" is answered with the bare text "PONG") ----
const num = z.unknown().transform(toNum).optional();
const str = z.unknown().transform((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)).optional();
const strs = z.unknown().transform((v): string[] => (Array.isArray(v) ? v.map(String) : [])).optional();
const side = z.unknown().transform((v) => (v === "BUY" || v === "SELL" ? v : undefined)).optional();
const RawChange = z.looseObject({ asset_id: z.string(), price: num, size: num, side, hash: str, best_bid: num, best_ask: num });
const RawPriceChange = z.looseObject({ market: str, timestamp: num, price_changes: z.array(z.unknown()).optional() });
const RawLastTrade = z.looseObject({ asset_id: z.string(), market: str, price: num, size: num, side, fee_rate_bps: num, timestamp: num, transaction_hash: str });
const RawBestBidAsk = z.looseObject({ asset_id: z.string(), market: str, best_bid: num, best_ask: num, spread: num, timestamp: num });
const RawTick = z.looseObject({ asset_id: z.string(), market: str, old_tick_size: num, new_tick_size: num, timestamp: num });
const RawNewMarket = z.looseObject({ id: str, market: str, question: str, slug: str, assets_ids: strs, outcomes: strs, timestamp: num });
const RawResolved = z.looseObject({ id: str, market: str, assets_ids: strs, winning_asset_id: str, winning_outcome: str, timestamp: num });

export type Side = "BUY" | "SELL";
/** One changed level: `size` is the new total resting at `price` on `side` (BUY = bids, SELL = asks); 0 = level removed. */
export type PriceChange = { token_id: string; price: number; size: number; side: Side; best_bid?: number; best_ask?: number };
export type MarketEvent =
  | { type: "book"; book: Book }
  | { type: "price_change"; condition_id?: string; ts?: number; changes: PriceChange[] }
  | { type: "last_trade"; token_id: string; condition_id?: string; ts?: number; price: number; size?: number; side?: Side; fee_rate_bps?: number; tx?: string }
  | { type: "best_bid_ask"; token_id: string; condition_id?: string; ts?: number; best_bid?: number; best_ask?: number; spread?: number }
  | { type: "tick_size_change"; token_id: string; condition_id?: string; ts?: number; old_tick_size?: number; new_tick_size?: number }
  | { type: "new_market"; id?: string; condition_id?: string; question?: string; slug?: string; token_ids: string[]; outcomes: string[]; ts?: number }
  | { type: "market_resolved"; id?: string; condition_id?: string; token_ids: string[]; winning_token_id?: string; winning_outcome?: string; ts?: number };

function convert(f: Record<string, unknown>): MarketEvent | undefined {
  switch (f.event_type) {
    case "book": {
      const book = normBook(f);
      return book && { type: "book", book };
    }
    case "price_change": {
      const r = RawPriceChange.safeParse(f);
      if (!r.success) return undefined;
      const changes = (r.data.price_changes ?? []).flatMap((x): PriceChange[] => {
        const c = RawChange.safeParse(x);
        if (!c.success || c.data.price === undefined || c.data.size === undefined || !c.data.side) return [];
        return [{ token_id: c.data.asset_id, price: c.data.price, size: c.data.size, side: c.data.side, best_bid: c.data.best_bid, best_ask: c.data.best_ask }];
      });
      return { type: "price_change", condition_id: r.data.market, ts: r.data.timestamp, changes };
    }
    case "last_trade_price": {
      const r = RawLastTrade.safeParse(f);
      if (!r.success) return undefined;
      const { price, ...t } = r.data;
      if (price === undefined) return undefined;
      return { type: "last_trade", token_id: t.asset_id, condition_id: t.market, ts: t.timestamp, price, size: t.size, side: t.side, fee_rate_bps: t.fee_rate_bps, tx: t.transaction_hash };
    }
    case "best_bid_ask": {
      const r = RawBestBidAsk.safeParse(f);
      return r.success ? { type: "best_bid_ask", token_id: r.data.asset_id, condition_id: r.data.market, ts: r.data.timestamp, best_bid: r.data.best_bid, best_ask: r.data.best_ask, spread: r.data.spread } : undefined;
    }
    case "tick_size_change": {
      const r = RawTick.safeParse(f);
      return r.success ? { type: "tick_size_change", token_id: r.data.asset_id, condition_id: r.data.market, ts: r.data.timestamp, old_tick_size: r.data.old_tick_size, new_tick_size: r.data.new_tick_size } : undefined;
    }
    case "new_market": {
      const r = RawNewMarket.safeParse(f);
      return r.success ? { type: "new_market", id: r.data.id, condition_id: r.data.market, question: r.data.question, slug: r.data.slug, token_ids: r.data.assets_ids ?? [], outcomes: r.data.outcomes ?? [], ts: r.data.timestamp } : undefined;
    }
    case "market_resolved": {
      const r = RawResolved.safeParse(f);
      return r.success ? { type: "market_resolved", id: r.data.id, condition_id: r.data.market, token_ids: r.data.assets_ids ?? [], winning_token_id: r.data.winning_asset_id, winning_outcome: r.data.winning_outcome, ts: r.data.timestamp } : undefined;
    }
    default:
      return undefined;
  }
}

/** One raw text frame -> zero or more events. Never throws: "PONG", bad JSON and unknown/invalid frames yield [] (observe them via `onInvalid`). */
export function parseWsMessage(raw: string, onInvalid?: (raw: string, why: unknown) => void): MarketEvent[] {
  if (raw === "PONG" || raw === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    onInvalid?.(raw, e);
    return [];
  }
  const out: MarketEvent[] = [];
  for (const item of Array.isArray(json) ? json : [json]) {
    const e = item && typeof item === "object" ? convert(item as Record<string, unknown>) : undefined;
    if (e) out.push(e);
    else onInvalid?.(raw, (item as { event_type?: unknown })?.event_type ?? "not an object");
  }
  return out;
}

// ---- local book maintenance ----
const EPS = 1e-9;
/** Pure: the book after one level change (replace / insert / remove at `price`), still best-first. */
export function applyPriceChange(book: Book, c: PriceChange, ts?: number): Book {
  const key = c.side === "BUY" ? "bids" : "asks";
  const rest = book[key].filter((l) => Math.abs(l.price - c.price) > EPS);
  const levels = c.size > 0 ? [...rest, { price: c.price, size: c.size }] : rest;
  levels.sort(c.side === "BUY" ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
  return { ...book, [key]: levels, timestamp: ts ?? book.timestamp };
}

export type BookStore = {
  /** token_id -> current book (snapshots applied, deltas folded in) */
  readonly books: ReadonlyMap<string, Book>;
  get(tokenId: string): Book | undefined;
  /** Folds one event in; returns the token ids whose book changed. Deltas for a token without a snapshot are dropped (they are meaningless until the next `book`). */
  apply(e: MarketEvent): string[];
  clear(): void;
};

export function bookStore(): BookStore {
  const books = new Map<string, Book>();
  return {
    books,
    get: (t) => books.get(t),
    apply(e) {
      switch (e.type) {
        case "book":
          books.set(e.book.token_id, e.book);
          return [e.book.token_id];
        case "price_change": {
          const touched = new Set<string>();
          for (const c of e.changes) {
            const b = books.get(c.token_id);
            if (!b) continue;
            books.set(c.token_id, applyPriceChange(b, c, e.ts));
            touched.add(c.token_id);
          }
          return [...touched];
        }
        case "tick_size_change": {
          const b = books.get(e.token_id);
          if (!b || e.new_tick_size === undefined) return [];
          books.set(e.token_id, { ...b, tick_size: e.new_tick_size });
          return [e.token_id];
        }
        case "last_trade": {
          const b = books.get(e.token_id);
          if (!b) return [];
          books.set(e.token_id, { ...b, last_trade_price: e.price });
          return [e.token_id];
        }
        default:
          return [];
      }
    },
    clear: () => books.clear(),
  };
}

// ---- socket ----
/** Minimal structural WebSocket (browser, Bun, Node >= 22, or a fake in tests). */
export type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type WsCtor = new (url: string) => WsLike;
export type SocketStatus = "connecting" | "open" | "closed";

export type MarketSocketOpts = {
  onEvent: (e: MarketEvent) => void;
  onStatus?: (s: SocketStatus, detail?: string) => void;
  onInvalid?: (raw: string, why: unknown) => void;
  url?: string;
  /** enables best_bid_ask, new_market, market_resolved frames (default true) */
  customFeatures?: boolean;
  /** heartbeat: the server drops silent clients; default 10 s */
  pingMs?: number;
  /** reconnect if no frame (incl. PONG) arrives for this long; default 30 s */
  staleMs?: number;
  reconnectMinMs?: number; // default 1 s
  reconnectMaxMs?: number; // default 30 s
  /** abort a connection attempt that has not opened within this long; default 10 s */
  connectTimeoutMs?: number;
  /** default: globalThis.WebSocket */
  WebSocketImpl?: WsCtor;
  random?: () => number;
};

export type MarketSocket = {
  subscribe(assetIds: string[]): void;
  unsubscribe(assetIds: string[]): void;
  readonly assets: ReadonlySet<string>;
  readonly status: SocketStatus;
  close(): void;
};

/**
 * Market-channel client: subscribes by asset (token) id, reconnects with exponential backoff + jitter, re-subscribes the
 * current asset set on every reconnect (so each (re)connect starts with fresh `book` snapshots), sends "PING" every `pingMs`,
 * and drops a connection that went silent for `staleMs`. `close()` is final: no reconnect afterwards.
 */
export function subscribeMarket(assetIds: string[], o: MarketSocketOpts): MarketSocket {
  const WS: WsCtor = o.WebSocketImpl ?? (globalThis as { WebSocket?: WsCtor }).WebSocket ?? (() => { throw new Error("subscribeMarket: no WebSocket implementation (pass WebSocketImpl)"); })();
  const assets = new Set(assetIds);
  const { pingMs = 10_000, staleMs = 30_000, reconnectMinMs = 1_000, reconnectMaxMs = 30_000, connectTimeoutMs = 10_000, random = Math.random } = o;
  const custom = o.customFeatures ?? true;
  let ws: WsLike | null = null;
  let closed = false;
  let attempt = 0;
  let status: SocketStatus = "connecting";
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastRx = 0;

  const setStatus = (s: SocketStatus, detail?: string) => { status = s; o.onStatus?.(s, detail); };
  const send = (msg: unknown) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
  const subscribeMsg = (ids: string[]) => ({ type: "market", assets_ids: ids, custom_feature_enabled: custom });

  function connect() {
    if (closed) return;
    setStatus("connecting");
    const sock = new WS(o.url ?? WS_MARKET_URL);
    ws = sock;
    let dead = false;
    // Single exit path per socket: close, error, connect timeout or staleness. Does not rely on the close event of a stuck socket.
    const drop = (detail: string) => {
      if (dead) return;
      dead = true;
      clearInterval(ping);
      clearTimeout(connectTimer);
      if (ws === sock) ws = null;
      try { sock.close(); } catch {}
      setStatus("closed", detail);
      if (closed) return;
      const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** attempt++) * (0.75 + random() * 0.5);
      retry = setTimeout(connect, delay);
    };
    const connectTimer = setTimeout(() => { if (sock.readyState !== 1) drop("connect timeout"); }, connectTimeoutMs);
    sock.onopen = () => {
      if (dead) return;
      clearTimeout(connectTimer);
      attempt = 0;
      lastRx = Date.now();
      setStatus("open");
      if (assets.size) send(subscribeMsg([...assets]));
      ping = setInterval(() => {
        if (Date.now() - lastRx > staleMs) return drop("stale");
        try { sock.send("PING"); } catch (e) { drop(`send failed: ${(e as Error)?.message ?? e}`); }
      }, pingMs);
    };
    sock.onmessage = (ev) => {
      lastRx = Date.now();
      for (const e of parseWsMessage(String(ev.data), o.onInvalid)) o.onEvent(e);
    };
    sock.onerror = () => {}; // always followed by onclose
    sock.onclose = (ev) => drop(`${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim());
  }
  connect();

  return {
    subscribe(ids) {
      const fresh = ids.filter((i) => !assets.has(i));
      for (const i of fresh) assets.add(i);
      if (fresh.length) send(assets.size === fresh.length ? subscribeMsg(fresh) : { operation: "subscribe", assets_ids: fresh });
    },
    unsubscribe(ids) {
      const had = ids.filter((i) => assets.delete(i));
      if (had.length) send({ operation: "unsubscribe", assets_ids: had });
    },
    get assets() { return assets; },
    get status() { return status; },
    close() {
      closed = true;
      clearInterval(ping);
      clearTimeout(retry);
      try { ws?.close(); } catch {}
      ws = null;
      setStatus("closed", "closed by caller");
    },
  };
}

/** subscribeMarket + bookStore: `onBook` fires with the current best-first book after every snapshot or delta for that token. */
export function subscribeBooks(assetIds: string[], onBook: (book: Book, event: MarketEvent) => void, o: Omit<MarketSocketOpts, "onEvent"> & { onEvent?: (e: MarketEvent) => void } = {}): MarketSocket & { store: BookStore } {
  const store = bookStore();
  const sock = subscribeMarket(assetIds, {
    ...o,
    onEvent: (e) => {
      o.onEvent?.(e);
      for (const t of store.apply(e)) onBook(store.get(t)!, e);
    },
  });
  return Object.assign(sock, { store });
}

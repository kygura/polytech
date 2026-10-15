import { z } from "zod";

// ---- lenient primitives: never fail, bad/missing -> undefined ----
const toNum = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
// .optional() so a missing key short-circuits (zod 4 would otherwise reject undefined from a required-looking transform)
const num = z.unknown().transform(toNum).optional();
const str = z.unknown().transform((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)).optional();
const bool = z.unknown().transform((v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined)).optional();
/** Array, or a JSON-string array (clobTokenIds/outcomes/outcomePrices). */
const arr = z.unknown().transform((v): unknown[] | undefined => {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(v) ? v : undefined;
}).optional();
/** Array whose bad items are dropped. */
const list = <T extends z.ZodType>(s: T) =>
  z.unknown().transform((v): z.output<T>[] | undefined =>
    Array.isArray(v) ? v.flatMap((x) => { const r = s.safeParse(x); return r.success ? [r.data] : []; }) : undefined,
  ).optional();

// ---- raw (pre-normalization) schemas, unknown keys pass through ----
const RawTag = z.looseObject({ id: str, label: str, slug: str });
const RawEventLite = z.looseObject({
  id: str, slug: str, title: str, endDate: str, negRisk: bool, enableNegRisk: bool, negRiskAugmented: bool,
  tags: list(RawTag),
});
const RawMarket = z.looseObject({
  id: str, question: str, conditionId: str, slug: str, description: str, category: str, groupItemTitle: str,
  endDate: str, endDateIso: str, outcomes: arr, outcomePrices: arr, clobTokenIds: arr,
  volume: num, volumeNum: num, volume24hr: num, liquidity: num, liquidityNum: num,
  lastTradePrice: num, bestBid: num, bestAsk: num, orderPriceMinTickSize: num, orderMinSize: num,
  negRisk: bool, negRiskMarketID: str, active: bool, closed: bool, archived: bool, acceptingOrders: bool, enableOrderBook: bool,
  umaResolutionStatus: str, events: list(RawEventLite),
});
const RawEvent = RawEventLite.extend({ markets: list(RawMarket) });
const RawLevel = z.looseObject({ price: num, size: num });
const RawBook = z.looseObject({
  market: str, asset_id: str, timestamp: num, bids: list(RawLevel), asks: list(RawLevel),
  tick_size: num, min_order_size: num, neg_risk: bool,
});
const RawComment = z.looseObject({
  id: str, body: str, parentEntityType: str, parentEntityID: str, userAddress: str, createdAt: str, reactionCount: num,
  profile: z.looseObject({ name: str, pseudonym: str }).optional().catch(undefined),
});
const RawHolder = z.looseObject({ proxyWallet: str, address: str, amount: num, balance: num, name: str });
const RawHolderGroup = z.looseObject({ token: str, holders: list(RawHolder) });
const RawTrade = z.looseObject({
  side: str, size: num, price: num, timestamp: num, asset: str, conditionId: str, transactionHash: str, proxyWallet: str,
});

// ---- normalized output (own types; planner reconciles with @pm/core) ----
export type Market = {
  id: string;
  condition_id: string;
  event_id?: string;
  slug?: string;
  question: string;
  rules?: string;
  category?: string;
  tags: string[];
  end_date?: string; // ISO
  neg_risk: boolean;
  neg_risk_group?: string;
  yes_token_id?: string;
  no_token_id?: string;
  yes_price?: number; // Gamma outcomePrices[yes]
  best_bid?: number;
  best_ask?: number;
  last_trade_price?: number;
  volume?: number;
  volume_24h?: number;
  liquidity?: number;
  tick_size?: number;
  min_order_size?: number;
  group_item_title?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  open: boolean; // active && !closed && !archived
  accepting_orders: boolean; // acceptingOrders !== false && enableOrderBook !== false
  uma_status?: string;
  in_dispute: boolean;
};
export type PmEvent = {
  id: string; slug?: string; title?: string; tags: string[]; end_date?: string;
  neg_risk: boolean; neg_risk_augmented: boolean; markets: Market[];
};
export type Level = { price: number; size: number };
/** bids best (highest) first, asks best (lowest) first, regardless of wire order. */
export type Book = {
  token_id: string; condition_id?: string; bids: Level[]; asks: Level[];
  tick_size?: number; min_order_size?: number; neg_risk?: boolean; timestamp?: number;
};
export type Comment = { id: string; body: string; entity_type?: string; entity_id?: string; created_at?: string; author?: string; reactions?: number };
export type HolderGroup = { token_id: string; holders: { wallet?: string; amount: number }[] };
export type Trade = { side?: string; size: number; price: number; ts: number; token_id?: string; condition_id?: string; tx?: string; wallet?: string };
export type HistoryPoint = { t: number; p: number };

const iso = (s?: string) => { const d = s ? new Date(s) : undefined; return d && !Number.isNaN(+d) ? d.toISOString() : undefined; };
const tagSlugs = (e?: z.output<typeof RawEventLite>) => (e?.tags ?? []).flatMap((t) => t.slug ?? t.label?.toLowerCase() ?? []);
const CATEGORIES = ["politics", "finance", "tech", "crypto", "geopolitics", "sports", "economy", "science", "culture"];

export function normMarket(raw: unknown, parent?: z.output<typeof RawEventLite>): Market | undefined {
  const r = RawMarket.safeParse(raw);
  if (!r.success) return undefined;
  const m = r.data;
  if (!m.conditionId || !m.question) return undefined;
  const ev = parent ?? m.events?.[0];
  const tags = tagSlugs(ev);
  const outs = (m.outcomes ?? []).map((o) => String(o).toLowerCase());
  const yes = Math.max(0, outs.indexOf("yes")); // non-yes/no markets: outcome 0 is "yes"
  const tok = (i: number) => { const t = m.clobTokenIds?.[i]; return typeof t === "string" || typeof t === "number" ? String(t) : undefined; };
  const neg = m.negRisk ?? ev?.negRisk ?? false;
  const accepting = m.acceptingOrders !== false && m.enableOrderBook !== false;
  return {
    id: m.id ?? m.conditionId,
    condition_id: m.conditionId,
    event_id: ev?.id,
    slug: m.slug,
    question: m.question,
    rules: m.description,
    category: m.category ?? tags.find((t) => CATEGORIES.includes(t)) ?? tags[0],
    tags,
    end_date: iso(m.endDate ?? m.endDateIso),
    neg_risk: neg,
    neg_risk_group: m.negRiskMarketID ?? (neg ? ev?.id : undefined), // negRiskMarketID unverified -> fall back to event id
    yes_token_id: tok(yes),
    no_token_id: tok(1 - yes),
    yes_price: toNum(m.outcomePrices?.[yes]),
    best_bid: m.bestBid,
    best_ask: m.bestAsk,
    last_trade_price: m.lastTradePrice,
    volume: m.volumeNum ?? m.volume,
    volume_24h: m.volume24hr,
    liquidity: m.liquidityNum ?? m.liquidity,
    tick_size: m.orderPriceMinTickSize,
    min_order_size: m.orderMinSize,
    group_item_title: m.groupItemTitle,
    active: m.active,
    closed: m.closed,
    archived: m.archived,
    open: m.active !== false && m.closed !== true && m.archived !== true,
    accepting_orders: accepting,
    uma_status: m.umaResolutionStatus,
    in_dispute: m.umaResolutionStatus?.toLowerCase() === "disputed",
  };
}

export function normEvent(raw: unknown): PmEvent | undefined {
  const r = RawEvent.safeParse(raw);
  if (!r.success || !r.data.id) return undefined;
  const e = r.data;
  return {
    id: e.id!, slug: e.slug, title: e.title, tags: tagSlugs(e), end_date: iso(e.endDate),
    neg_risk: e.negRisk ?? e.enableNegRisk ?? false, neg_risk_augmented: e.negRiskAugmented ?? false,
    markets: (e.markets ?? []).flatMap((m) => normMarket(m, e) ?? []),
  };
}

const best = (ls: Level[], dir: 1 | -1) => [...ls].sort((a, b) => dir * (a.price - b.price));
export function normBook(raw: unknown): Book | undefined {
  const r = RawBook.safeParse(raw);
  if (!r.success || !r.data.asset_id) return undefined;
  const b = r.data;
  const lv = (xs?: { price?: number; size?: number }[]) => (xs ?? []).flatMap((x) => (x.price !== undefined && x.size !== undefined ? [{ price: x.price, size: x.size }] : []));
  return {
    token_id: b.asset_id!, condition_id: b.market, bids: best(lv(b.bids), -1), asks: best(lv(b.asks), 1),
    tick_size: b.tick_size, min_order_size: b.min_order_size, neg_risk: b.neg_risk, timestamp: b.timestamp,
  };
}

/** token -> number from either `{token: v}` / `{token: {k: v}}` or `[{token_id|asset_id, k: v}]` (batch shapes are unverified). */
export function normTokenMap(raw: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (o: unknown) => {
    if (o && typeof o === "object") for (const k of keys) { const n = toNum((o as Record<string, unknown>)[k]); if (n !== undefined) return n; }
    return toNum(o);
  };
  if (Array.isArray(raw)) {
    for (const o of raw as Record<string, unknown>[]) {
      const id = o?.token_id ?? o?.asset_id; const n = pick(o);
      if (typeof id === "string" && n !== undefined) out[id] = n;
    }
  } else if (raw && typeof raw === "object") {
    for (const [id, v] of Object.entries(raw)) { const n = pick(v); if (n !== undefined) out[id] = n; }
  }
  return out;
}

export function normComments(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = RawComment.safeParse(x);
    if (!r.success || !r.data.body) return [];
    const c = r.data;
    return [{ id: c.id ?? "", body: c.body!, entity_type: c.parentEntityType, entity_id: c.parentEntityID, created_at: iso(c.createdAt), author: c.profile?.name ?? c.profile?.pseudonym ?? c.userAddress, reactions: c.reactionCount }];
  });
}

export function normHolders(raw: unknown): HolderGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = RawHolderGroup.safeParse(x);
    if (!r.success || !r.data.token) return [];
    return [{ token_id: r.data.token, holders: (r.data.holders ?? []).flatMap((h) => { const a = h.amount ?? h.balance; return a === undefined ? [] : [{ wallet: h.proxyWallet ?? h.address, amount: a }]; }) }];
  });
}

export function normOi(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(raw)) for (const o of raw as Record<string, unknown>[]) { const v = toNum(o?.value); if (typeof o?.market === "string" && v !== undefined) out[o.market] = v; }
  return out;
}

export function normTrades(raw: unknown): Trade[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = RawTrade.safeParse(x);
    if (!r.success) return [];
    const t = r.data;
    if (t.size === undefined || t.price === undefined || t.timestamp === undefined) return [];
    return [{ side: t.side, size: t.size, price: t.price, ts: t.timestamp, token_id: t.asset, condition_id: t.conditionId, tx: t.transactionHash, wallet: t.proxyWallet }];
  });
}

export function normHistory(raw: unknown): HistoryPoint[] {
  const h = (raw as { history?: unknown })?.history;
  if (!Array.isArray(h)) return [];
  return h.flatMap((x: Record<string, unknown>) => { const t = toNum(x?.t), p = toNum(x?.p); return t !== undefined && p !== undefined ? [{ t, p }] : []; });
}

export { toNum };

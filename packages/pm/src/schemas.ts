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
/** Gamma timestamps are ISO or '2026-10-20 13:05:04.275395+00'; both -> ISO-8601, anything else -> undefined. */
export const toIso = (v: unknown): string | undefined => {
  if (typeof v !== "string" || v === "") return undefined;
  const t = Date.parse(v.replace(" ", "T").replace(/(T[\d:.]+[+-]\d{2})$/, "$1:00"));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

// ---- raw (pre-normalization) schemas, unknown keys pass through ----
const RawTag = z.looseObject({ id: str, label: str, slug: str });
const RawFeeSchedule = z.looseObject({ rate: num, exponent: num, takerOnly: bool, rebateRate: num });
const RawEventLite = z.looseObject({
  id: str, slug: str, title: str, endDate: str, negRisk: bool, enableNegRisk: bool, negRiskAugmented: bool,
  tags: list(RawTag),
});
const RawMarket = z.looseObject({
  id: str, question: str, conditionId: str, slug: str, description: str, category: str, groupItemTitle: str,
  startDate: str, endDate: str, endDateIso: str, closedTime: str, outcomes: arr, outcomePrices: arr, clobTokenIds: arr,
  volume: num, volumeNum: num, volume24hr: num, liquidity: num, liquidityNum: num, liquidityClob: num,
  lastTradePrice: num, bestBid: num, bestAsk: num, spread: num, orderPriceMinTickSize: num, orderMinSize: num,
  negRisk: bool, negRiskMarketID: str, negRiskAugmented: bool, active: bool, closed: bool, archived: bool, acceptingOrders: bool, enableOrderBook: bool,
  umaResolutionStatus: str, feesEnabled: bool, feeType: str, feeSchedule: RawFeeSchedule.optional().catch(undefined),
  events: list(RawEventLite), tags: list(RawTag),
});
const RawEvent = RawEventLite.extend({ markets: list(RawMarket), liquidity: num, volume: num, volume24hr: num, openInterest: num, active: bool, closed: bool });
const RawLevel = z.looseObject({ price: num, size: num });
const RawBook = z.looseObject({
  market: str, asset_id: str, timestamp: num, hash: str, bids: list(RawLevel), asks: list(RawLevel),
  tick_size: num, min_order_size: num, neg_risk: bool, last_trade_price: num,
});
const RawComment = z.looseObject({
  id: str, body: str, parentEntityType: str, parentEntityID: str, userAddress: str, createdAt: str, reactionCount: num,
  profile: z.looseObject({ name: str, pseudonym: str }).optional().catch(undefined),
});
// Data API: v2 rows are snake_case inside {data}, v1 rows camelCase in a bare array; both are accepted.
const RawHolder = z.looseObject({ proxy_wallet: str, proxyWallet: str, address: str, amount: num, balance: num, outcome_index: num, outcomeIndex: num, name: str, pseudonym: str });
const RawHolderGroup = z.looseObject({ token_id: str, token: str, holders: list(RawHolder) });
const RawTrade = z.looseObject({
  side: str, size: num, price: num, timestamp: num, token_id: str, asset: str, condition_id: str, conditionId: str,
  outcome: str, outcome_index: num, outcomeIndex: num, transaction_hash: str, transactionHash: str, proxy_wallet: str, proxyWallet: str,
});
const RawClobMarket = z.looseObject({
  c: str, t: list(z.looseObject({ t: str, o: str })), mos: num, mts: num, mbf: num, tbf: num, ao: bool,
  fd: z.looseObject({ r: num, e: num, to: bool }).optional().catch(undefined),
});

// ---- normalized output (own types; planner reconciles with @pm/core) ----
/** Taker fee curve: fee = shares * rate * (p * (1 - p)) ^ exponent. Makers never pay when taker_only. */
export type FeeSchedule = { rate: number; exponent: number; taker_only: boolean; rebate_rate?: number };
export type Market = {
  id: string;
  condition_id: string;
  event_id?: string;
  slug?: string;
  question: string;
  rules?: string;
  category?: string;
  tags: string[];
  start_date?: string; // ISO
  end_date?: string; // ISO
  /** ISO, set once the market is closed */
  closed_time?: string;
  neg_risk: boolean;
  neg_risk_group?: string;
  /** neg-risk event that can still add outcomes (placeholder "other"): sibling prices need not sum to 1 */
  neg_risk_augmented: boolean;
  outcomes: string[];
  outcome_prices: number[];
  yes_token_id?: string;
  no_token_id?: string;
  yes_price?: number; // Gamma outcomePrices[yes]
  best_bid?: number;
  best_ask?: number;
  spread?: number;
  last_trade_price?: number;
  volume?: number;
  volume_24h?: number;
  liquidity?: number;
  tick_size?: number;
  min_order_size?: number;
  /** Taker fee parameter in bps (fee_schedule.rate * 1e4). 0 only when Gamma says feesEnabled=false; undefined = no fee info. */
  fee_bps?: number;
  fee_schedule?: FeeSchedule;
  fees_enabled?: boolean;
  fee_type?: string;
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
  active?: boolean; closed?: boolean; liquidity?: number; volume?: number; volume_24h?: number; open_interest?: number;
  neg_risk: boolean; neg_risk_augmented: boolean; markets: Market[];
};
export type Level = { price: number; size: number };
/** bids best (highest) first, asks best (lowest) first, regardless of wire order. */
export type Book = {
  token_id: string; condition_id?: string; bids: Level[]; asks: Level[];
  tick_size?: number; min_order_size?: number; neg_risk?: boolean; timestamp?: number; hash?: string; last_trade_price?: number;
};
export type Comment = { id: string; body: string; entity_type?: string; entity_id?: string; created_at?: string; author?: string; reactions?: number };
export type Holder = { wallet?: string; amount: number; outcome_index?: number; name?: string };
/** holders are in the API's order (amount descending) */
export type HolderGroup = { token_id: string; holders: Holder[] };
export type Trade = {
  side?: string; size: number; price: number; /** unix seconds */ ts: number; token_id?: string; condition_id?: string;
  outcome?: string; outcome_index?: number; tx?: string; wallet?: string;
};
export type HistoryPoint = { /** unix seconds */ t: number; p: number };
/** CLOB `GET /clob-markets/{conditionId}`: the venue's own order rules and the authoritative fee curve (`fd`). */
export type ClobMarketInfo = {
  condition_id?: string; tokens: { token_id: string; outcome?: string }[];
  min_order_size?: number; tick_size?: number; accepting_orders?: boolean;
  /** legacy base fees, bps (same source as /fee-rate; not the 2026 fee curve) */
  maker_base_fee_bps?: number; taker_base_fee_bps?: number;
  /** undefined when the CLOB omits `fd` (fee-free market) */
  fee_schedule?: FeeSchedule;
};

const tagSlugs = (e?: { tags?: { slug?: string; label?: string }[] }) => (e?.tags ?? []).flatMap((t) => t.slug ?? t.label?.toLowerCase() ?? []);
const CATEGORIES = ["politics", "finance", "tech", "crypto", "geopolitics", "sports", "economy", "science", "culture"];
/** bps rounded to 2dp to kill float noise (0.04 * 10000 = 400.00000000000006). */
const toBps = (rate: number) => Math.round(rate * 1e6) / 100;
const feeSchedule = (fs?: z.output<typeof RawFeeSchedule>): FeeSchedule | undefined =>
  fs?.rate === undefined ? undefined : { rate: fs.rate, exponent: fs.exponent ?? 1, taker_only: fs.takerOnly ?? true, rebate_rate: fs.rebateRate };
/** Taker fee in USDC for `shares` at `price` (docs: trading/fees), rounded to 5dp. */
export const takerFee = (shares: number, price: number, fs: Pick<FeeSchedule, "rate" | "exponent">) =>
  Math.round(shares * fs.rate * Math.pow(price * (1 - price), fs.exponent) * 1e5) / 1e5;

export function normMarket(raw: unknown, parent?: z.output<typeof RawEventLite>): Market | undefined {
  const r = RawMarket.safeParse(raw);
  if (!r.success) return undefined;
  const m = r.data;
  if (!m.conditionId || !m.question) return undefined;
  const ev = parent ?? m.events?.[0];
  const tags = tagSlugs(m.tags?.length ? m : ev);
  const outcomes = (m.outcomes ?? []).map(String);
  const outs = outcomes.map((o) => o.toLowerCase());
  const yes = Math.max(0, outs.indexOf("yes")); // non-yes/no markets: outcome 0 is "yes"
  const tok = (i: number) => { const t = m.clobTokenIds?.[i]; return typeof t === "string" || typeof t === "number" ? String(t) : undefined; };
  const neg = m.negRisk ?? ev?.negRisk ?? false;
  const accepting = m.acceptingOrders !== false && m.enableOrderBook !== false;
  const fs = feeSchedule(m.feeSchedule);
  return {
    id: m.id ?? m.conditionId,
    condition_id: m.conditionId,
    event_id: ev?.id,
    slug: m.slug,
    question: m.question,
    rules: m.description,
    category: m.category ?? tags.find((t) => CATEGORIES.includes(t)) ?? tags[0],
    tags,
    start_date: toIso(m.startDate),
    end_date: toIso(m.endDate ?? m.endDateIso),
    closed_time: toIso(m.closedTime),
    neg_risk: neg,
    neg_risk_group: m.negRiskMarketID ?? (neg ? ev?.id : undefined), // negRiskMarketID unverified -> fall back to event id
    neg_risk_augmented: m.negRiskAugmented ?? ev?.negRiskAugmented ?? false,
    outcomes,
    outcome_prices: (m.outcomePrices ?? []).flatMap((p) => toNum(p) ?? []),
    yes_token_id: tok(yes),
    no_token_id: tok(1 - yes),
    yes_price: toNum(m.outcomePrices?.[yes]),
    best_bid: m.bestBid,
    best_ask: m.bestAsk,
    spread: m.spread,
    last_trade_price: m.lastTradePrice,
    volume: m.volumeNum ?? m.volume,
    volume_24h: m.volume24hr,
    liquidity: m.liquidityNum ?? m.liquidity ?? m.liquidityClob,
    tick_size: m.orderPriceMinTickSize,
    min_order_size: m.orderMinSize,
    fee_bps: fs ? toBps(fs.rate) : m.feesEnabled === false ? 0 : undefined,
    fee_schedule: fs,
    fees_enabled: m.feesEnabled,
    fee_type: m.feeType,
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
    id: e.id!, slug: e.slug, title: e.title, tags: tagSlugs(e), end_date: toIso(e.endDate),
    active: e.active, closed: e.closed, liquidity: e.liquidity, volume: e.volume, volume_24h: e.volume24hr, open_interest: e.openInterest,
    neg_risk: e.negRisk ?? e.enableNegRisk ?? false, neg_risk_augmented: e.negRiskAugmented ?? false,
    markets: (e.markets ?? []).flatMap((m) => normMarket(m, e) ?? []),
  };
}

/** The wire order is worst-first (bids ascending, asks descending); best-first is the contract everywhere in pm. */
export const sortLevels = (bids: Level[], asks: Level[]) => ({ bids: [...bids].sort((a, b) => b.price - a.price), asks: [...asks].sort((a, b) => a.price - b.price) });
const levels = (xs?: { price?: number; size?: number }[]) => (xs ?? []).flatMap((x) => (x.price !== undefined && x.size !== undefined ? [{ price: x.price, size: x.size }] : []));
export function normBook(raw: unknown): Book | undefined {
  const r = RawBook.safeParse(raw);
  if (!r.success || !r.data.asset_id) return undefined;
  const b = r.data;
  return {
    token_id: b.asset_id!, condition_id: b.market, ...sortLevels(levels(b.bids), levels(b.asks)),
    tick_size: b.tick_size, min_order_size: b.min_order_size, neg_risk: b.neg_risk, timestamp: b.timestamp, hash: b.hash, last_trade_price: b.last_trade_price,
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
    return [{ id: c.id ?? "", body: c.body!, entity_type: c.parentEntityType, entity_id: c.parentEntityID, created_at: toIso(c.createdAt), author: c.profile?.name ?? c.profile?.pseudonym ?? c.userAddress, reactions: c.reactionCount }];
  });
}

/** Data API v2 wraps rows in `{data}`; v1 was a bare array. */
const rows = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : []);

export function normHolders(raw: unknown): HolderGroup[] {
  return rows(raw).flatMap((x) => {
    const r = RawHolderGroup.safeParse(x);
    if (!r.success) return [];
    const token = r.data.token_id ?? r.data.token;
    if (!token) return [];
    return [{
      token_id: token,
      holders: (r.data.holders ?? []).flatMap((h) => {
        const a = h.amount ?? h.balance;
        return a === undefined ? [] : [{ wallet: h.proxy_wallet ?? h.proxyWallet ?? h.address, amount: a, outcome_index: h.outcome_index ?? h.outcomeIndex, name: h.name || h.pseudonym || undefined }];
      }),
    }];
  });
}

export function normOi(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of rows(raw) as Record<string, unknown>[]) {
    const v = toNum(o?.value), c = o?.condition_id ?? o?.market;
    if (typeof c === "string" && v !== undefined) out[c] = v;
  }
  return out;
}

export function normTrades(raw: unknown): Trade[] {
  return rows(raw).flatMap((x) => {
    const r = RawTrade.safeParse(x);
    if (!r.success) return [];
    const t = r.data;
    if (t.size === undefined || t.price === undefined || t.timestamp === undefined) return [];
    return [{
      side: t.side?.toUpperCase(), size: t.size, price: t.price, ts: t.timestamp, token_id: t.token_id ?? t.asset, condition_id: t.condition_id ?? t.conditionId,
      outcome: t.outcome, outcome_index: t.outcome_index ?? t.outcomeIndex, tx: t.transaction_hash ?? t.transactionHash, wallet: t.proxy_wallet ?? t.proxyWallet,
    }];
  });
}

export function normHistory(raw: unknown): HistoryPoint[] {
  const h = (raw as { history?: unknown })?.history;
  if (!Array.isArray(h)) return [];
  return h.flatMap((x: Record<string, unknown>) => { const t = toNum(x?.t), p = toNum(x?.p); return t !== undefined && p !== undefined ? [{ t, p }] : []; });
}

export function normClobMarket(raw: unknown): ClobMarketInfo | undefined {
  const r = RawClobMarket.safeParse(raw);
  if (!r.success) return undefined;
  const m = r.data;
  const tokens = (m.t ?? []).flatMap((t) => (t.t ? [{ token_id: t.t, outcome: t.o }] : []));
  if (!m.c && !tokens.length) return undefined;
  return {
    condition_id: m.c, tokens, min_order_size: m.mos, tick_size: m.mts, accepting_orders: m.ao, maker_base_fee_bps: m.mbf, taker_base_fee_bps: m.tbf,
    fee_schedule: m.fd?.r === undefined ? undefined : { rate: m.fd.r, exponent: m.fd.e ?? 1, taker_only: m.fd.to ?? true },
  };
}

export { toNum };

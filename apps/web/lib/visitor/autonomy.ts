// Visitor autonomy: pure decision (decide / recheck) + the sent-ledger and the one place an order leaves the browser (sendEntry).
// Rules mirror the server's apps/web/lib/jobs/live.ts (propose / autoGate / decide / send) and paper.ts (assess, exposureOf); risk runs on a LIVE book only.
import {
  autoAllowed, checkOrder, crowd, gtdExpiry, livelimitPrice, midOf, pass1, proposalExpiry, qualifies, sizeTrade,
  type Exposure, type Level, type Market, type Snapshot, type WatchCore,
} from "@pm/core";
import { scrub, type Exchange, type OpenOrder } from "@pm/pm/exchange";
import { z } from "zod";
import type { PublicMarketDetail, PublicWatchlist, PublicWatchRow } from "../public";
import { toAppSettings, type VisitorSettings } from "./settings";

const DAY = 86_400_000;
export const STALE_MS = 2 * 3_600_000; // SPEC: the loop skips data older than 2 h
export const PROPOSAL_TTL_MS = 10 * 60_000; // DESIGN 10.6 (server: 15 min)
const SHARE_STEP = 100; // shares rounded down to 0.01 so cost never exceeds the risk-checked sizeUsd (live.ts)
const FALLBACK: Record<string, string> = { STRUCTURAL_NOT_AUTO: "STRUCTURAL_AUTO_OFF", L3_PER_TRADE: "PER_TRADE", L3_DAILY_NOTIONAL: "DAILY_AUTO_NOTIONAL", CATEGORY_NOT_ALLOWED: "CATEGORY_NOT_ALLOWED" }; // live.ts:FALLBACK

// ---------------------------------------------------------------- ledger
export const LEDGER_KEY = "polytech.visitor.ledger";
export type LedgerStore = Pick<Storage, "getItem" | "setItem">;
/** queued = L2 proposal awaiting approval; sending = written BEFORE place; unknown = place threw (may have reached the venue): never resent. */
export const LEDGER_STATUS = ["queued", "sending", "sent", "unknown", "failed", "rejected", "expired"] as const;
export type LedgerStatus = (typeof LEDGER_STATUS)[number];
export const EntrySchema = z.object({
  thesisId: z.string(), conditionId: z.string(), tokenId: z.string(), eventId: z.string(), category: z.string(), question: z.string(),
  side: z.enum(["YES", "NO"]), limitPrice: z.number(), shares: z.number(), sizeUsd: z.number(), sideMid: z.number(), edgeC: z.number(),
  thesisExpiresAt: z.number().nullable(), at: z.number(), status: z.enum(LEDGER_STATUS),
  via: z.enum(["auto", "user"]).optional(), orderId: z.string().optional(), error: z.string().optional(), reason: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof EntrySchema>;
/** One entry per thesis id. ponytail: never pruned (~300 B each); prune terminal entries older than a thesis lifetime if storage ever matters. */
export type Ledger = Record<string, LedgerEntry>;

/** Missing = {}. Corrupt THROWS: an empty ledger would forget 'unknown' orders and allow a resend. */
export function loadLedger(s: LedgerStore): Ledger {
  const raw = s.getItem(LEDGER_KEY);
  if (!raw) return {};
  try {
    return z.record(z.string(), EntrySchema).parse(JSON.parse(raw));
  } catch {
    throw new Error("sent-ledger is corrupt: loop stopped, no orders sent");
  }
}
export const putEntry = (s: LedgerStore, e: LedgerEntry): LedgerEntry => (s.setItem(LEDGER_KEY, JSON.stringify({ ...loadLedger(s), [e.thesisId]: e })), e);

const dayStart = (now: number) => Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
/** Notional of auto-sent orders created today (failed / rejected excluded), as live.ts autoToday. */
export const autoNotionalToday = (l: Ledger, now: number) =>
  Object.values(l).reduce((n, e) => (e.via === "auto" && e.at >= dayStart(now) && ["sending", "sent", "unknown"].includes(e.status) ? n + e.sizeUsd : n), 0);

// ---------------------------------------------------------------- exposure
export type TokenInfo = { conditionId: string; eventId: string; category: string; price: number };
/**
 * Exchange holdings -> core Exposure. positions: tokenId -> shares; orders: open orders (remaining shares at limit).
 * Valued at cost: ledger limit price, else the candidate's side mid (`info`), else 1 (upper bound, fail-safe; such tokens count toward totalOpen only).
 * Ledger 'sending'/'unknown' entries from today may not be visible on the exchange yet: counted too (over-count = fail-safe, as live.ts exposureOf).
 * ponytail: dailyRealizedLoss is not tracked in the browser, so the DAILY_LOSS rule never fires.
 */
export function buildExposure(a: { bankroll: number; positions: Record<string, number>; orders: OpenOrder[]; ledger: Ledger; info: Record<string, TokenInfo>; now: number }): Exposure {
  const x: Exposure = { bankroll: a.bankroll, byMarket: {}, byEvent: {}, byCategory: {}, totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 };
  const byTok = { ...a.info };
  for (const e of Object.values(a.ledger)) byTok[e.tokenId] = { conditionId: e.conditionId, eventId: e.eventId, category: e.category, price: e.limitPrice };
  const add = (usd: number, i?: Pick<TokenInfo, "conditionId" | "eventId" | "category">) => {
    x.totalOpen += usd;
    if (!i) return;
    for (const [o, k] of [[x.byMarket, i.conditionId], [x.byEvent, i.eventId], [x.byCategory, i.category]] as const) o[k] = (o[k] ?? 0) + usd;
  };
  for (const [tok, n] of Object.entries(a.positions)) add(n * (byTok[tok]?.price ?? 1), byTok[tok]);
  for (const o of a.orders) add(Math.max(0, o.shares - o.filled) * o.price, byTok[o.tokenId]);
  for (const e of Object.values(a.ledger)) {
    if (e.at < dayStart(a.now)) continue;
    if (["sending", "unknown"].includes(e.status)) add(e.sizeUsd, e);
    if (["sending", "sent", "unknown"].includes(e.status)) x.dailyNotional += e.sizeUsd; // "approved/sent today"
  }
  return x;
}

// ---------------------------------------------------------------- live book
export type LiveBook = { bids: Level[]; asks: Level[]; tick: number; minShares: number };
type WireLevel = { price: string | number; size: string | number };
/** SDK OrderBook (decimal strings, any order) -> numbers; non-finite or non-positive levels are dropped. */
export function toLiveBook(b: { bids: WireLevel[]; asks: WireLevel[]; tickSize: string | number; minOrderSize: string | number }): LiveBook {
  const lv = (xs: WireLevel[]) => xs.map((l) => ({ price: Number(l.price), size: Number(l.size) })).filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
  return { bids: lv(b.bids), asks: lv(b.asks), tick: Number(b.tickSize), minShares: Number(b.minOrderSize) || 0 };
}

// ---------------------------------------------------------------- assess
export type Candidate = { detail: PublicMarketDetail; book: LiveBook };
type Assessed = { ok: false; reason: string; thesisId: string } | {
  ok: true; thesisId: string; conditionId: string; tokenId: string; eventId: string; category: string; question: string; side: "YES" | "NO";
  limitPrice: number; shares: number; sizeUsd: number; sideMid: number; pPost: number; edgeC: number; thesisExpiresAt: number | null;
};

/** paper.ts assess + live.ts propose steps for one candidate: size on the live book, qualify, limit price, share rounding. */
export function assess(c: Candidate, st: ReturnType<typeof toAppSettings>, now: number): Assessed {
  const { detail: d, book } = c, t = d.thesis, snap = d.snapshot, m = d.market;
  const no = (reason: string): Assessed => ({ ok: false, reason, thesisId: t?.id ?? "" });
  if (d.research !== "done" || !t) return no("NO_RESEARCH");
  if (!snap || now - snap.ts > STALE_MS) return no("STALE_DATA");
  if (t.expiresAt != null && t.expiresAt <= now) return no("THESIS_EXPIRED");
  if (t.pYes == null || m.endDate == null) return no("NO_THESIS_INPUT");
  const pMid = midOf(book.bids, book.asks);
  if (pMid == null) return no("NO_BOOK");
  let sz: WatchCore | null;
  try {
    const cr = crowd({ top10Share: snap.top10Share ?? 0, netFlow: snap.netFlow, skew: 0 });
    sz = sizeTrade({ bids: book.bids, asks: book.asks, pMid, pHat: t.pYes, c: t.c, daysLeft: (m.endDate - now) / DAY, feeRate: m.feeRate, feeExponent: m.feeExponent, crowdC: cr.c, crowdSide: cr.side, settings: st });
  } catch {
    return no("BAD_INPUT"); // sizeTrade throws RangeError on out-of-range probabilities
  }
  if (!sz || sz.side !== t.side || sz.sizeUsd <= 0) return no("NO_EDGE_NOW");
  const core: Market = {
    conditionId: m.conditionId, eventId: m.eventId ?? m.conditionId, question: m.question, rules: m.rules, category: m.category ?? "other", tags: m.tags,
    endDate: m.endDate, negRiskGroup: m.negRiskGroup, feeRate: m.feeRate, feeExponent: m.feeExponent, open: ["active", "disputed", "not_accepting"].includes(m.status),
    acceptingOrders: m.status !== "not_accepting", inDispute: m.status === "disputed",
  };
  const live: Snapshot = { conditionId: m.conditionId, ts: now, bids: book.bids, asks: book.asks, vol24h: snap.vol24h ?? 0, oi: snap.oi ?? 0, top10Share: snap.top10Share ?? 0, lastTradeTs: null };
  const q = qualifies({ edge: sz.e, confidence: t.c, disagreementCapTripped: !!t.capped }, { categoryThreshold: st.limits.categoryThreshold, bookAgeMs: 0, pass1: pass1(core, live, st, now).ok });
  if (!q.ok) return no(q.failed.join(","));
  const tokenId = t.side === "YES" ? m.yesTokenId : m.noTokenId;
  const limit = livelimitPrice({ vwap: sz.sizeUsd / sz.shares, pPost: sz.pPost, tick: book.tick });
  if (!tokenId || limit == null) return no("NO_LIMIT");
  if (!gtdExpiry(t.expiresAt == null ? null : new Date(t.expiresAt), new Date(now))) return no("THESIS_EXPIRING");
  const shares = Math.floor((sz.sizeUsd / limit) * SHARE_STEP) / SHARE_STEP;
  if (!(shares > 0) || shares < book.minShares) return no("NO_LIMIT");
  return {
    ok: true, thesisId: t.id, conditionId: m.conditionId, tokenId, eventId: core.negRiskGroup ?? core.eventId, category: core.category, question: m.question, side: t.side,
    limitPrice: limit, shares, sizeUsd: shares * limit, sideMid: sz.pMid, pPost: sz.pPost, edgeC: sz.edgeC, thesisExpiresAt: t.expiresAt,
  };
}

// ---------------------------------------------------------------- candidates
export const MAX_CANDIDATES = 5; // detail + book fetches per tick (public API: 60 req/min/IP)
/** Watchlist rows worth a detail fetch: finished, unexpired thesis not yet in the ledger, best edge first. */
export const pickCandidates = (w: Pick<PublicWatchlist, "rows">, ledger: Ledger, n = MAX_CANDIDATES): PublicWatchRow[] =>
  w.rows.filter((r) => r.research === "done" && r.thesisId != null && !r.expired && !r.capped && (!ledger[r.thesisId] || ledger[r.thesisId]!.status === "expired"))
    .sort((a, b) => (b.edgeC ?? -Infinity) - (a.edgeC ?? -Infinity)).slice(0, n);

// ---------------------------------------------------------------- decide
export type Action = {
  kind: "propose" | "send" | "skip"; thesisId: string; conditionId: string; tokenId: string; side: "YES" | "NO";
  limitPrice: number; sizeUsd: number; reason: string;
  // extras the executor / UI need; the order is always a BUY of `tokenId`
  shares: number; category: string; eventId: string; question: string; sideMid: number; edgeC: number; thesisExpiresAt: number | null;
};
export type DecideInput = {
  watchlist: Pick<PublicWatchlist, "snapshotAt" | "research">;
  candidates: Candidate[]; // details + LIVE book fetched just before deciding
  settings: VisitorSettings;
  exposure: Exposure; // from buildExposure
  ledger: Ledger;
  now: number;
};

const skipOf = (d: PublicMarketDetail, reason: string): Action => ({
  kind: "skip", thesisId: d.thesis?.id ?? "", conditionId: d.market.conditionId, tokenId: "", side: d.thesis?.side ?? "YES", limitPrice: 0, sizeUsd: 0, reason,
  shares: 0, category: d.market.category ?? "other", eventId: d.market.eventId ?? d.market.conditionId, question: d.market.question, sideMid: 0, edgeC: 0, thesisExpiresAt: d.thesis?.expiresAt ?? null,
});

/** manual: nothing. L2: propose. L3: send iff autoAllowed (l3 caps + daily auto cap) else propose with the fallback reason. L4: send iff checkOrder ok. */
export function decide(i: DecideInput): Action[] {
  const mode = i.settings.mode;
  if (mode === "manual") return [];
  const st = toAppSettings(i.settings), x = structuredClone(i.exposure);
  let auto = autoNotionalToday(i.ledger, i.now);
  const stale = i.watchlist.snapshotAt == null || i.now - i.watchlist.snapshotAt > STALE_MS;
  const out: Action[] = [];
  for (const c of i.candidates) {
    const d = c.detail, tid = d.thesis?.id;
    // rejected / failed / unknown theses are not re-proposed; only expired proposals are (live.ts `done`)
    if (tid && i.ledger[tid] && i.ledger[tid]!.status !== "expired") { out.push(skipOf(d, "DUPLICATE")); continue; }
    if (i.watchlist.research === "disabled") { out.push(skipOf(d, "NO_RESEARCH")); continue; }
    if (stale) { out.push(skipOf(d, "STALE_DATA")); continue; }
    if ((x.byMarket[d.market.conditionId] ?? 0) > 0) { out.push(skipOf(d, "HELD")); continue; } // open position or order on the market
    const a = assess(c, st, i.now);
    if (!a.ok) { out.push(skipOf(d, a.reason)); continue; }
    const chk = checkOrder({ sizeUsd: a.sizeUsd, marketId: a.conditionId, eventId: a.eventId, category: a.category }, x, st.limits);
    if (!chk.ok) { out.push(skipOf(d, chk.violations.map((v) => `RISK_${v.rule}`).join(","))); continue; }
    const gate = mode === "L3" ? autoAllowed({ sizeUsd: a.sizeUsd, category: a.category }, st.limits.l3, auto) : null;
    const fallback = gate && !gate.ok ? (FALLBACK[gate.reason!] ?? gate.reason!) : null;
    const send = mode === "L4" || (mode === "L3" && !fallback);
    const { ok: _ok, pPost: _p, ...rest } = a;
    out.push({ ...rest, kind: send ? "send" : "propose", reason: send ? `${mode}_AUTO` : (fallback ?? "L2_APPROVE") });
    for (const [o, k] of [[x.byMarket, a.conditionId], [x.byEvent, a.eventId], [x.byCategory, a.category]] as const) o[k] = (o[k] ?? 0) + a.sizeUsd; // later candidates see this one
    x.totalOpen += a.sizeUsd;
    x.dailyNotional += a.sizeUsd;
    if (send) auto += a.sizeUsd;
  }
  return out;
}

/** Approve-time re-check on a fresh book (live.ts decide): null = may send; else why the proposal dies and as which status. */
export function recheck(e: LedgerEntry, c: Candidate, x: Exposure, v: VisitorSettings, now: number): { status: "expired" | "failed"; reason: string } | null {
  const st = toAppSettings(v), dead = (reason: string) => ({ status: "expired" as const, reason });
  if (now - e.at >= PROPOSAL_TTL_MS) return dead("TIMEOUT");
  const a = assess(c, st, now);
  if (!a.ok) return dead("PRICE_MOVED"); // no usable book / edge gone: cannot prove the price held
  const move = proposalExpiry({ createdAt: new Date(e.at), priceAtProposal: e.sideMid }, new Date(now), a.sideMid);
  if (move) return dead(move);
  if (livelimitPrice({ vwap: e.limitPrice, pPost: a.pPost, tick: c.book.tick }) == null) return dead("PRICE_MOVED");
  const chk = checkOrder({ sizeUsd: e.sizeUsd, marketId: e.conditionId, eventId: e.eventId, category: e.category }, x, st.limits);
  return chk.ok ? null : { status: "failed", reason: `risk: ${chk.violations.map((r) => r.rule).join(",")}` };
}

// ---------------------------------------------------------------- send
export const entryOf = (a: Action, now: number): LedgerEntry => ({
  thesisId: a.thesisId, conditionId: a.conditionId, tokenId: a.tokenId, eventId: a.eventId, category: a.category, question: a.question, side: a.side,
  limitPrice: a.limitPrice, shares: a.shares, sizeUsd: a.sizeUsd, sideMid: a.sideMid, edgeC: a.edgeC, thesisExpiresAt: a.thesisExpiresAt, at: now, status: "queued", reason: a.reason,
});

/**
 * Exactly one exchange.place per thesis. The ledger row is written 'sending' BEFORE place and never re-sent while sending / sent / unknown / failed / rejected
 * (only a missing, queued or expired row may send). A throw from place is ambiguous (may have reached the venue) => 'unknown', no retry (live.ts send).
 * `canSend` is re-checked right before the only exchange call (kill can land between the decision and here). Returns the final row.
 */
export async function sendEntry(ex: Pick<Exchange, "place">, e: LedgerEntry, via: "auto" | "user", s: LedgerStore, now: number, canSend: () => boolean = () => true): Promise<LedgerEntry> {
  const cur = loadLedger(s)[e.thesisId];
  if (cur && cur.status !== "queued" && cur.status !== "expired") return cur;
  const expiresAt = gtdExpiry(e.thesisExpiresAt == null ? null : new Date(e.thesisExpiresAt), new Date(now));
  if (!expiresAt) return putEntry(s, { ...e, via, status: "failed", error: "thesis expiring" });
  putEntry(s, { ...e, via, status: "sending" }); // throws (storage full) before anything is sent
  if (!canSend()) return putEntry(s, { ...e, via, status: "failed", error: "KILLED" }); // never sent
  try {
    const p = await ex.place({ tokenId: e.tokenId, side: "BUY", price: e.limitPrice, shares: e.shares, expiresAt });
    return putEntry(s, { ...e, via, status: p.status === "rejected" ? "failed" : "sent", orderId: p.orderId || undefined, error: p.error ? scrub(p.error).slice(0, 300) : undefined });
  } catch (err) {
    return putEntry(s, { ...e, via, status: "unknown", error: scrub(err instanceof Error ? err.message : "place failed").slice(0, 300) });
  }
}

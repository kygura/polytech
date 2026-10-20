import { takerFeePerShare } from "../fees";
import { checkOrder, type Exposure, type Limits, type Violation } from "./risk";

export interface SetLeg {
  sizeUsd: number;
  marketId: string;
}

/** A neg-risk set is one order on one event: aggregate cost through checkOrder, plus PER_MARKET per leg. */
export function checkSet(legs: SetLeg[], event: { eventId: string; category: string }, x: Exposure, l: Limits): { ok: boolean; violations: Violation[] } {
  const total = legs.reduce((t, g) => t + g.sizeUsd, 0);
  const agg = checkOrder({ sizeUsd: total, marketId: "\0set", ...event }, x, l).violations.filter((v) => v.rule !== "PER_MARKET");
  const perMarket = legs.flatMap((g) => {
    const value = (x.byMarket[g.marketId] ?? 0) + g.sizeUsd;
    return value <= l.perMarket + 1e-9 ? [] : [{ rule: "PER_MARKET" as const, limit: l.perMarket, value }];
  });
  const violations = [...agg, ...perMarket];
  return { ok: violations.length === 0, violations };
}

export interface L3Limits {
  perTradeUsd: number;
  dailyNotional: number;
  categoryAllowlist: string[];
  structuralAuto: boolean;
}

/** L3 auto-send check; !ok falls back to L2 approval. An empty allowlist allows no category (fail closed). */
export function autoAllowed(o: { sizeUsd: number; category: string; isSet?: boolean }, l3: L3Limits, autoSentToday: number): { ok: boolean; reason?: string } {
  if (o.isSet && !l3.structuralAuto) return { ok: false, reason: "STRUCTURAL_NOT_AUTO" };
  if (!l3.categoryAllowlist.includes(o.category)) return { ok: false, reason: "CATEGORY_NOT_ALLOWED" };
  if (!(o.sizeUsd <= l3.perTradeUsd + 1e-9)) return { ok: false, reason: "L3_PER_TRADE" };
  if (!(autoSentToday + o.sizeUsd <= l3.dailyNotional + 1e-9)) return { ok: false, reason: "L3_DAILY_NOTIONAL" };
  return { ok: true };
}

export interface SetInputLeg {
  conditionId: string;
  yesToken: string;
  noToken: string;
  ask: { price: number; size: number }; // best ask (buy-all)
  bid: { price: number; size: number }; // best bid (sell-all)
}
export interface PlannedLeg {
  conditionId: string;
  token: string;
  shares: number;
  limit: number; // FOK BUY cap price
}
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

/**
 * All legs are BUYs: buy-all = YES at the ask; sell-all = NO at 1 - bid (pays n-1). Thinnest leg first.
 * Each leg is capped at price + slack; edge is the worst-case locked profit after fees. null edge <= 0 or too thin.
 */
export function setLegPlan(kind: "buy-all" | "sell-all", legs: SetInputLeg[], shares: number, feeRate = 0, slack = 0.01, feeExponent = 1):
  | { ok: true; legs: PlannedLeg[]; totalCost: number; edge: number }
  | { ok: false; reason: "TOO_THIN" | "NO_EDGE" } {
  const buy = kind === "buy-all";
  const rows = legs.map((g) => {
    const q = buy ? g.ask : { price: 1 - g.bid.price, size: g.bid.size };
    return { g, size: q.size, limit: Math.min(0.99, r8(q.price + slack)) };
  });
  if (rows.some((r) => !(r.size >= shares))) return { ok: false, reason: "TOO_THIN" };
  const perShare = rows.reduce((t, r) => t + r.limit + takerFeePerShare(feeRate, r.limit, feeExponent), 0);
  const edge = r8(shares * ((buy ? 1 : legs.length - 1) - perShare));
  if (!(edge > 0)) return { ok: false, reason: "NO_EDGE" };
  rows.sort((a, b) => a.size - b.size);
  return {
    ok: true,
    legs: rows.map((r) => ({ conditionId: r.g.conditionId, token: buy ? r.g.yesToken : r.g.noToken, shares, limit: r.limit })),
    totalCost: r8(shares * perShare),
    edge,
  };
}

/** Capped SELL for every filled leg of a partial set; floor = fill - 0.02, never below 0.01. */
export function unwindPlan(filled: { conditionId: string; token: string; shares: number; fillPrice: number }[]) {
  return filled.map((f) => ({ conditionId: f.conditionId, token: f.token, side: "SELL" as const, shares: f.shares, floor: Math.max(0.01, r8(f.fillPrice - 0.02)) }));
}

/** Exit when the thesis was killed, or a re-research landed on the opposite side. */
export function exitDecision(thesis: { status: string; side: string }, latest: { side: string } | null, position: { shares: number }): { exit: boolean; reason?: "killed" | "flipped" } {
  if (!(position.shares > 0)) return { exit: false };
  if (thesis.status === "killed") return { exit: true, reason: "killed" };
  if (latest && latest.side !== thesis.side) return { exit: true, reason: "flipped" };
  return { exit: false };
}

export interface LiveTrade {
  approved: boolean; // sent after a human approval
  side: "BUY" | "SELL";
  modeledPrice: number;
  fillPrice: number;
  at: Date;
  realizedPnl?: number; // USD, once closed
}

/** Feeds gateProgress L2->L3 / L3->L4. Slippage > 0 = worse than modeled. */
export function gateStats(trades: LiveTrade[], now: Date) {
  const slip = trades.map((t) => (t.side === "BUY" ? t.fillPrice - t.modeledPrice : t.modeledPrice - t.fillPrice));
  const since = now.getTime() - 30 * 86_400_000;
  return {
    approvedLiveTrades: trades.filter((t) => t.approved).length,
    avgSlippage: slip.length ? slip.reduce((a, b) => a + b, 0) / slip.length : undefined,
    liveTrades: trades.length,
    realizedEdge30d: trades.filter((t) => t.at.getTime() >= since).reduce((a, t) => a + (t.realizedPnl ?? 0), 0),
  };
}

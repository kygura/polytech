export interface Limits {
  perTradeUsd: number;
  perTradePct: number; // of bankroll, 0.05 = 5%
  perMarket: number;
  perEvent: number;
  perCategory: number;
  totalOpen: number;
  dailyNotional: number;
  dailyLoss: number;
}
export interface Exposure {
  bankroll: number;
  byMarket: Record<string, number>;
  byEvent: Record<string, number>; // neg-risk group = one event id
  byCategory: Record<string, number>;
  totalOpen: number;
  dailyNotional: number;
  dailyRealizedLoss: number; // positive number = loss
}
export interface Order {
  sizeUsd: number;
  marketId: string;
  eventId: string;
  category: string;
}
export interface Violation {
  rule: "PER_TRADE_USD" | "PER_TRADE_PCT" | "PER_MARKET" | "PER_EVENT" | "PER_CATEGORY" | "TOTAL_OPEN" | "DAILY_NOTIONAL" | "DAILY_LOSS";
  limit: number;
  value: number;
}

/** Pure check; L1 paper records violations, L2+ would reject on them. */
export function checkOrder(o: Order, x: Exposure, l: Limits): { ok: boolean; violations: Violation[] } {
  const v: Violation[] = [];
  const over = (rule: Violation["rule"], value: number, limit: number) => {
    if (!(value <= limit + 1e-9)) v.push({ rule, limit, value });
  };
  over("PER_TRADE_USD", o.sizeUsd, l.perTradeUsd);
  over("PER_TRADE_PCT", o.sizeUsd, l.perTradePct * x.bankroll);
  over("PER_MARKET", (x.byMarket[o.marketId] ?? 0) + o.sizeUsd, l.perMarket);
  over("PER_EVENT", (x.byEvent[o.eventId] ?? 0) + o.sizeUsd, l.perEvent);
  over("PER_CATEGORY", (x.byCategory[o.category] ?? 0) + o.sizeUsd, l.perCategory);
  over("TOTAL_OPEN", x.totalOpen + o.sizeUsd, l.totalOpen);
  over("DAILY_NOTIONAL", x.dailyNotional + o.sizeUsd, l.dailyNotional);
  if (!(x.dailyRealizedLoss < l.dailyLoss)) v.push({ rule: "DAILY_LOSS", limit: l.dailyLoss, value: x.dailyRealizedLoss });
  return { ok: v.length === 0, violations: v };
}

// Crowd metrics from Data API holders and trades. Pure; the jobs map client rows onto these minimal inputs.
import type { Side } from "./types";

export type HolderInput = { amount: number }; // shares held (one row per wallet)
export type HolderMetrics = { holderCount: number; hhi: number; top1Share: number; top5Share: number };

/**
 * Concentration of the YES token's holders over the rows given (the API returns the top N, so `holderCount` is capped at N
 * and HHI/top shares are relative to those N, not the whole book). Null when nothing is held.
 */
export function holderMetrics(holders: readonly HolderInput[]): HolderMetrics | null {
  const amts = holders.map((h) => h.amount).filter((a) => Number.isFinite(a) && a > 0);
  const total = amts.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const shares = amts.map((v) => v / total).sort((a, b) => b - a);
  return {
    holderCount: shares.length,
    hhi: shares.reduce((a, s) => a + s * s, 0),
    top1Share: shares[0]!,
    top5Share: shares.slice(0, 5).reduce((a, b) => a + b, 0),
  };
}

export type TradeInput = { side: "BUY" | "SELL"; size: number; price: number; ts: number; outcome: Side }; // ts epoch ms
export type TradeMetrics = { flow24h: number; tradeMedian: number | null; largeTrade24h: boolean; lastTradeTs: number | null };

export const LARGE_TRADE_USD = 500;
const DAY_MS = 86_400_000;

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Signed taker flow in USDC (buy YES / sell NO positive) over the trades within `windowMs` of `now`; median ticket and
 * large-trade flag over the same window. No trades in the window is a real answer (flow 0), not missing data.
 * `lastTradeTs` is the newest trade among all rows given (older trades may be passed to cover a quiet market).
 */
export function tradeMetrics(
  trades: readonly TradeInput[], now: number, opts: { windowMs?: number; largeUsd?: number } = {},
): TradeMetrics {
  const windowMs = opts.windowMs ?? DAY_MS, largeUsd = opts.largeUsd ?? LARGE_TRADE_USD;
  let flow = 0, last: number | null = null;
  const tickets: number[] = [];
  for (const t of trades) {
    if (!Number.isFinite(t.ts)) continue;
    if (last == null || t.ts > last) last = t.ts;
    if (t.ts < now - windowMs || t.ts > now) continue;
    const usd = t.size * t.price;
    if (!Number.isFinite(usd)) continue;
    flow += usd * (t.side === "BUY" ? 1 : -1) * (t.outcome === "YES" ? 1 : -1);
    tickets.push(usd);
  }
  return { flow24h: flow, tradeMedian: median(tickets), largeTrade24h: tickets.some((u) => u >= largeUsd), lastTradeTs: last };
}

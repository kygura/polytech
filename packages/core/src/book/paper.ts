import type { BookLevel, Outcome, PaperFillResult, Position } from "./types";

/** Hypothetical buy of `sizeUsd` walking the asks. Fee = feeRate * p(1-p) per share at the VWAP (SPEC k(S)). */
export function paperFill(asks: BookLevel[], sizeUsd: number, feeRate = 0): PaperFillResult {
  let left = sizeUsd;
  let shares = 0;
  for (const a of [...asks].sort((x, y) => x.price - y.price)) {
    if (left <= 0) break;
    const take = Math.min(a.size, left / a.price);
    shares += take;
    left -= take * a.price;
  }
  const filled = sizeUsd - Math.max(left, 0);
  const avgPrice = shares ? filled / shares : 0;
  return { avgPrice, shares, filled, complete: left <= 1e-9, fee: feeRate * avgPrice * (1 - avgPrice) * shares };
}

export interface Fill {
  side: "buy" | "sell";
  shares: number;
  price: number;
  fee: number;
}

/** Long-only position of one outcome token. Fees go into cost basis on buys, off pnl on sells. */
export function applyFill(p: Position, f: Fill): Position {
  if (f.side === "buy") {
    const shares = p.shares + f.shares;
    return { ...p, shares, avgCost: (p.shares * p.avgCost + f.shares * f.price + f.fee) / shares };
  }
  if (f.shares > p.shares) throw new RangeError("sell exceeds position");
  return { ...p, shares: p.shares - f.shares, realizedPnl: p.realizedPnl + f.shares * (f.price - p.avgCost) - f.fee };
}

export const settle = (p: Position, outcome: Outcome): Position => ({
  shares: 0,
  avgCost: p.avgCost,
  realizedPnl: p.realizedPnl + p.shares * (outcome - p.avgCost),
});

export interface PaperTrade {
  shares: number;
  avgPrice: number;
  fee: number;
  modeledEdge: number; // per share, e(S) at fill time
  outcome: Outcome | null;
}

/** Share-weighted per-share edge, realized vs modeled, over resolved trades only. */
export function realizedEdge(trades: PaperTrade[]): { n: number; realized: number; modeled: number; gap: number } {
  let n = 0, shares = 0, pnl = 0, modeled = 0;
  for (const t of trades) {
    if (t.outcome === null) continue;
    n++;
    shares += t.shares;
    pnl += t.shares * (t.outcome - t.avgPrice) - t.fee;
    modeled += t.shares * t.modeledEdge;
  }
  if (!shares) return { n, realized: 0, modeled: 0, gap: 0 };
  return { n, realized: pnl / shares, modeled: modeled / shares, gap: (pnl - modeled) / shares };
}

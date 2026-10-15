import type { Level } from "../types";

const EPS = 1e-9;
const valid = (l: Level) => l.price > 0 && l.price < 1 && l.size > 0;
const asc = (ls: Level[]) => ls.filter(valid).sort((a, b) => a.price - b.price);

export function midOf(bids: Level[], asks: Level[]): number | null {
  const b = bids.filter(valid), a = asks.filter(valid);
  if (!b.length || !a.length) return null;
  return (Math.max(...b.map((l) => l.price)) + Math.min(...a.map((l) => l.price))) / 2;
}

/** USD notional of levels priced within `cents` of `ref`. */
export function depthWithin(levels: Level[], ref: number, cents: number): number {
  return levels
    .filter((l) => valid(l) && Math.abs(l.price - ref) <= cents / 100 + EPS)
    .reduce((s, l) => s + l.price * l.size, 0);
}

/** Average price paid spending `usd` up the ask ladder; null if the book is too thin. usd<=0 -> best ask. */
export function vwapForUsd(asks: Level[], usd: number): number | null {
  const ls = asc(asks);
  if (!ls.length) return null;
  if (usd <= 0) return ls[0]!.price;
  let left = usd, shares = 0;
  for (const l of ls) {
    const cost = l.price * l.size;
    if (left <= cost + EPS) return usd / (shares + left / l.price);
    left -= cost;
    shares += l.size;
  }
  return null;
}

/** Same book seen from the other token: price -> 1 - price. */
export const mirror = (levels: Level[]): Level[] =>
  levels.map((l) => ({ price: 1 - l.price, size: l.size }));

export { asc as sortAsc };

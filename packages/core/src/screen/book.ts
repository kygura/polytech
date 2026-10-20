import { DEFAULT_SETTINGS, type Level } from "../types";

const EPS = 1e-9;
const valid = (l: Level) => l.price > 0 && l.price < 1 && l.size > 0;
const asc = (ls: Level[]) => ls.filter(valid).sort((a, b) => a.price - b.price);

/** YES-token book in any order; helpers sort. Snapshot satisfies it. */
export type Book = { bids: Level[]; asks: Level[] };

export function midOf(bids: Level[], asks: Level[]): number | null {
  const b = bids.filter(valid), a = asks.filter(valid);
  if (!b.length || !a.length) return null;
  return (Math.max(...b.map((l) => l.price)) + Math.min(...a.map((l) => l.price))) / 2;
}

export function bestBid(book: Book): number | null {
  const p = book.bids.filter(valid).map((l) => l.price);
  return p.length ? Math.max(...p) : null;
}
export function bestAsk(book: Book): number | null {
  const p = book.asks.filter(valid).map((l) => l.price);
  return p.length ? Math.min(...p) : null;
}
/** Null unless both sides exist. */
export function spread(book: Book): number | null {
  const b = bestBid(book), a = bestAsk(book);
  return b == null || a == null ? null : a - b;
}

/** USD notional of levels priced within `cents` of `ref`. */
export function depthWithin(levels: Level[], ref: number, cents: number): number {
  return levels
    .filter((l) => valid(l) && Math.abs(l.price - ref) <= cents / 100 + EPS)
    .reduce((s, l) => s + l.price * l.size, 0);
}

/** USD resting within `cents` of mid, both sides summed. 0 when mid is unknown. */
export function depthAt(book: Book, cents: number): number {
  const m = midOf(book.bids, book.asks);
  return m == null ? 0 : depthWithin(book.bids, m, cents) + depthWithin(book.asks, m, cents);
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

export type SlippagePoint = { size: number; vwap: number; slippage: number }; // size USD

/** VWAP and slippage (vwap - best ask) per USD size. Sizes the book cannot fill (or <= 0) are omitted. */
export function slippageCurve(book: Book, sizes: number[]): SlippagePoint[] {
  const ba = bestAsk(book);
  const out: SlippagePoint[] = [];
  if (ba == null) return out;
  for (const size of sizes) {
    if (!(size > 0)) continue;
    const vwap = vwapForUsd(book.asks, size);
    if (vwap != null) out.push({ size, vwap, slippage: vwap - ba });
  }
  return out;
}

/** Max USD buyable with VWAP <= `target` (VWAP is non-decreasing in size, so a level walk suffices). */
export function capacityAtVwap(asks: Level[], target: number): number {
  let cost = 0, shares = 0;
  for (const l of asc(asks)) {
    if (l.price > target + EPS) {
      // marginal price above target: add x with (cost+x)/(shares+x/p) = target
      const x = (target * shares - cost) / (1 - target / l.price);
      return cost + Math.min(Math.max(x, 0), l.price * l.size);
    }
    cost += l.price * l.size;
    shares += l.size;
  }
  return cost;
}

/** Max USD with VWAP - best ask <= eps (prob units). */
export function capacity(asks: Level[], eps: number): number {
  const s = asc(asks);
  if (!s.length || !(eps >= 0)) return 0;
  return capacityAtVwap(s, s[0]!.price + eps);
}

/** USD of bids within 5c of the best *bid* (what a seller can actually hit). Known whenever bids exist, even with no asks. */
export function exitDepth(book: Book): number | null {
  const b = bestBid(book);
  return b == null ? null : depthWithin(book.bids, b, 5);
}

/** Same book seen from the other token: price -> 1 - price. */
export const mirror = (levels: Level[]): Level[] =>
  levels.map((l) => ({ price: 1 - l.price, size: l.size }));

const r10 = (x: number) => Math.round(x * 1e10) / 1e10;
/** NO-token book from the YES book: NO asks = 1 - YES bids, NO bids = 1 - YES asks (best first). */
export function complementBook(yes: Book): Book {
  const flip = (ls: Level[]) => mirror(ls.filter(valid)).map((l) => ({ price: r10(l.price), size: l.size }));
  return {
    bids: flip(yes.asks).sort((a, b) => b.price - a.price),
    asks: flip(yes.bids).sort((a, b) => a.price - b.price),
  };
}

/** market_latest book columns. Depths null without a mid; capacity null without asks; exitDepth null without bids. */
export type BookMetrics = {
  mid: number | null; bestBid: number | null; bestAsk: number | null; spread: number | null;
  depth1c: number | null; depth2c: number | null; depth5c: number | null;
  exitDepth: number | null; capacity: number | null;
};

export function bookMetrics(book: Book, slippageEps = DEFAULT_SETTINGS.slippageCents / 100): BookMetrics {
  const m = midOf(book.bids, book.asks), ba = bestAsk(book);
  return {
    mid: m, bestBid: bestBid(book), bestAsk: ba, spread: spread(book),
    depth1c: m == null ? null : depthAt(book, 1),
    depth2c: m == null ? null : depthAt(book, 2),
    depth5c: m == null ? null : depthAt(book, 5),
    exitDepth: exitDepth(book),
    capacity: ba == null ? null : capacity(book.asks, slippageEps),
  };
}

/** Cheap stable hash (FNV-1a, hex) of the top `n` levels per side: equal hashes mean an unchanged snapshot. */
export function bookHash(book: Book, n = 10): string {
  const bids = [...book.bids.filter(valid)].sort((a, b) => b.price - a.price).slice(0, n);
  const asks = asc(book.asks).slice(0, n);
  const s = `${bids.map((l) => `${l.price}:${l.size}`).join(",")}|${asks.map((l) => `${l.price}:${l.size}`).join(",")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export { asc as sortAsc };

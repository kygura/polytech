// Pure terminal helpers (DESIGN 11.2, 11.7): outcome mirroring, cents display, update-tint diffs, nudges. No React.
import type { FeedLevel, MarketFeed } from "../../hooks/useMarketFeed";
import { roundTick, tickDecimals } from "./ticket";

export type Outcome = "YES" | "NO";
export type TradeSide = "BUY" | "SELL";

const r6 = (p: number) => Math.round(p * 1e6) / 1e6;
const flip = (p: number) => r6(1 - p);
const flipLevel = (l: FeedLevel): FeedLevel => ({ price: flip(l.price), size: l.size });

/** The chosen outcome's book. The feed is the YES token; NO is its mirror: NO bids = 1 − YES asks (best first stays best first). */
export function forOutcome(f: MarketFeed, o: Outcome): MarketFeed {
  if (o === "YES") return f;
  return { ...f, bids: f.asks.map(flipLevel), asks: f.bids.map(flipLevel), mid: f.mid == null ? null : flip(f.mid), last: f.last == null ? null : flip(f.last) };
}

/** Polymarket's display rule: the YES midpoint, unless the book is wider than 10¢, then the last trade (a 1¢ bid / 82¢ ask is not a 42¢ price). */
export const WIDE_SPREAD = 0.1;
export function displayYes(b: { bid: number | null | undefined; ask: number | null | undefined; mid: number | null | undefined; last: number | null | undefined }): number | null {
  const wide = b.bid != null && b.ask != null && b.ask - b.bid > WIDE_SPREAD + 1e-9;
  return wide && b.last != null ? b.last : b.mid ?? b.last ?? null;
}
export const isWide = (bid: number | null | undefined, ask: number | null | undefined) => bid != null && ask != null && ask - bid > WIDE_SPREAD + 1e-9;
/** The feed's YES token display price (see `displayYes`). */
export const feedDisplay = (f: Pick<MarketFeed, "bids" | "asks" | "mid" | "last">) => displayYes({ bid: f.bids[0]?.price, ask: f.asks[0]?.price, mid: f.mid, last: f.last });

/** Cents decimals for a tick: 0.01 -> 0 (`41¢`), 0.001 -> 1 (`41.2¢`). */
export const centDecimals = (tick: number) => Math.max(0, tickDecimals(tick) - 2);
/** A 0–1 price in cents on the tick's decimals, no unit. */
export const cents = (p: number | null | undefined, tick: number) => (p == null ? "—" : (p * 100).toFixed(centDecimals(tick)));

/** Prices whose size changed at the same price between two payloads. No previous payload = nothing changed. */
export function changedSizes(prev: FeedLevel[] | null, cur: FeedLevel[]): Set<number> {
  const out = new Set<number>();
  if (!prev) return out;
  const was = new Map(prev.map((l) => [l.price, l.size]));
  for (const l of cur) { const s = was.get(l.price); if (s != null && s !== l.size) out.add(l.price); }
  return out;
}

export const tradeKey = (t: MarketFeed["trades"][number]) => `${t.ts}|${t.price}|${t.size}|${t.side}`;

/** ±n ticks from `p` (first rounded to the tick for `side`), clamped to [tick, 1 − tick]. */
export const nudge = (side: TradeSide, p: number, n: number, tick: number) => r6(Math.min(1 - tick, Math.max(tick, roundTick(side, p, tick) + n * tick)));

export const sh = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
export const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const usdShort = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

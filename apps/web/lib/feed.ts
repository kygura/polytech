import type { Pm } from "@pm/pm";
import { z } from "zod";

// Live /trade feed for one market (YES token). Client-safe: zod + a type import only.
// Delivery = short-interval poll of this cached endpoint (CDN s-maxage collapses the upstream calls across instances).
export const FEED_POLL_MS = 3_000;
const DEPTH = 15, TAPE = 50;
const Level = z.object({ price: z.number(), size: z.number() });
export const MarketFeedSchema = z.object({
  tokenId: z.string(),
  tickSize: z.number().positive(),
  minOrderSize: z.number().nullable(),
  bids: z.array(Level), // best (highest) first
  asks: z.array(Level), // best (lowest) first
  mid: z.number().nullable(),
  last: z.number().nullable(),
  trades: z.array(z.object({ side: z.enum(["BUY", "SELL"]).nullable(), price: z.number(), size: z.number(), ts: z.number() })), // newest first, ts = epoch seconds
  at: z.number(), // server epoch ms
});
export type MarketFeed = z.infer<typeof MarketFeedSchema>;
export type FeedLevel = z.infer<typeof Level>;

/** null = the venue has no book for the token. Throws when the book call fails; last price and tape are best-effort. */
export async function marketFeed(pm: Pick<Pm, "books" | "lastTradePrices" | "trades">, m: { conditionId: string; yesTokenId: string; tickSize: number | null }, now: number): Promise<MarketFeed | null> {
  const t = m.yesTokenId;
  const [books, last, tape] = await Promise.all([pm.books([t]), pm.lastTradePrices([t]).catch(() => ({}) as Record<string, number>), pm.trades({ market: [m.conditionId], limit: 100 }).catch(() => [])]);
  const b = books.find((x) => x.token_id === t);
  if (!b) return null;
  const bid = b.bids[0]?.price, ask = b.asks[0]?.price;
  return {
    tokenId: t,
    tickSize: b.tick_size ?? m.tickSize ?? 0.01,
    minOrderSize: b.min_order_size ?? null,
    bids: b.bids.slice(0, DEPTH), asks: b.asks.slice(0, DEPTH),
    mid: bid != null && ask != null ? (bid + ask) / 2 : null,
    last: last[t] ?? null,
    trades: tape.filter((x) => x.token_id === t).sort((a, c) => c.ts - a.ts).slice(0, TAPE)
      .map((x) => ({ side: x.side === "BUY" || x.side === "SELL" ? x.side : null, price: x.price, size: x.size, ts: x.ts })), // wallet/tx dropped on purpose
    at: now,
  };
}

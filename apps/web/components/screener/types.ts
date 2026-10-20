import type { SortField } from "@pm/core";

/** One `/api/markets` row as JSON (dates are ISO strings). */
export type ScreenerRow = {
  conditionId: string; question: string; category: string | null; tags: string[]; endDate: string | null;
  liquidity: number | null; vol24h: number | null; resolutionSource: string | null; negRiskAugmented: boolean;
  ts: string | null; mid: number | null; bestBid: number | null; bestAsk: number | null; spread: number | null;
  depth1c: number | null; depth2c: number | null; depth5c: number | null; exitDepth: number | null; capacity: number | null;
  holderCount: number | null; holderHhi: number | null; top1Share: number | null; top5Share: number | null;
  flow24h: number | null; tradeMedian: number | null; largeTrade24h: boolean | null; lastTradeTs: string | null;
  priority: number | null; structural: string[] | null;
  opportunity: { side: string; edge: number; stake: number; o: number; contrarian: boolean } | null;
  pinned: boolean; muted: boolean;
  d24c: number | null; // YES mid change over 24h, cents (null until a snapshot is 24h old)
  thesis: { id: string; side: string; edgeC: number; pPost: number; expired: boolean } | null;
};

export type SavedView = { id: string; name: string; query: string; columns: string[] };
export type SortSpec = { field: SortField; dir: "asc" | "desc" };

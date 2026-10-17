// Minimal response shapes, mirrored from apps/web/lib/jobs/read.ts (docs/api.md).
export type Side = "YES" | "NO";
export type Mode = "L0" | "L1" | "L2" | "L3" | "L4";
type N = number | null;

export type WatchlistRow = {
  conditionId: string; question: string; category: string | null; pinned: boolean; muted: boolean; researching: boolean;
  daysLeft: number; thesisAgeH: N; capped: boolean | null; nextCatalyst: string | null;
  side: Side | null; pMid: N; pHat: N; c: N; pPost: N; edgeC: N; payoff: N; rAnn: N; sizeUsd: N; expectedProfit: N; rank: N;
};
export type StructuralRow = {
  conditionId: string; question: string; category: string | null; pinned: boolean; muted: boolean;
  type: string; kind: string | null; legs: number; sum: N; lockedC: number; sizeUsd: number; daysLeft: number;
};

export type MarketDetail = {
  market: { conditionId: string; question: string; category: string | null; endDate: N; daysLeft: number; feeRate: N; pinned: boolean; muted: boolean };
  snapshot: { mid: number; bestBid: N; bestAsk: N; depth5cUsd: N; vol24h: N; oi: N; top10Share: N; bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
  history: { ts: number; mid: number }[];
  thesis: {
    createdAt: number; expiresAt: N; side: Side; pHat: number; c: number; pPost: number; edgeC: number; sizeUsd: number; rAnn: number;
    catalysts: string[]; killCriteria: string[]; thesis?: string; k?: number; payoff?: number; expectedProfit?: number; model?: string;
  } | null;
  evidence: { id: number; role: string; claim: string; quote: string | null; url: string | null; direction: number; publishedAt: N }[];
};

export type Pod = {
  id: string; question: string | null; trigger: string; status: string; startedAt: number; costSandboxS: N;
  agents: { role: string; model: string; status: string; durationS: N; usage: { inputTokens: number; outputTokens: number; costUsd: number }; output: unknown }[];
};
export type Fleet = {
  budget: { podsToday: number; maxPodsPerDay: number; activeSandboxes: number; maxConcurrentSandboxes: number; sandboxS: number; spendTodayUsd: number; dailySpendCapUsd: number; tokensIn: number; tokensOut: number };
  pods: Pod[];
};

export type Agg = { n: number; brier: number; logLoss: number; marketBrier: number };
export type Calibration = { n: number; overall: Agg | null; byCategory: Record<string, Agg & { c: number; gate: string }>; byModel: Record<string, Agg> };

export type PaperBook = {
  summary: { open: number; closed: number; paperPnlUsd: number; modeledEdgeUsd: number; realizedEdgeUsd: number; capture: N };
  positions: { id: number; conditionId: string; question: string; side: Side; size: number; avgCost: number; midNow: N; unrealizedUsd: N; modeledEdgeC: N; realizedEdgeC: N; openedAt: number; closedAt: N }[];
  fills: { ts: number; conditionId: string; question: string; side: Side | null; price: number; size: number; fee: number; modeledK: N; slipC: N }[];
};

export type Autonomy = {
  mode: Mode; executionEnabled: boolean;
  exchangeConfigured?: boolean; pendingCount?: number; liveOpenOrders?: number; recon?: Recon | null;
  categories: { category: string; override: Mode | null; effective: Mode }[];
  limits: { perTradeUsd: number; perTradePct: number; dailyLoss: number };
  usage: { totalOpen: number; dailyNotional: number; dailyRealizedLoss: number };
  gates: { gate: string; met: boolean; detail: string }[];
  events: { id: number; ts: number; fromMode: Mode; toMode: Mode; scope: string; reason: string; actor: string }[];
};

// Phase 6 live execution (DESIGN 8.6/8.7), mirrored from apps/web/lib/jobs/read.ts.
export type Recon = { at: N; status: "ok" | "mismatch" | "late" | null; detail: string | null };
export type Proposal = {
  id: string; conditionId: string; question: string; side: Side; orderSide?: "BUY" | "SELL"; shares: number; limitPrice: number; costUsd: number;
  edgeC: N; expectedProfitUsd: number; midAtProposal: number; midNow: N; createdAt: number; expiresAt: number;
  state: "pending" | "sending" | "sent" | "rejected" | "expired" | "failed"; reason: string | null; error: string | null; orderId: string | null;
};
export type Proposals = { pending: Proposal[]; recent: Proposal[] };
export type LiveBook = {
  positions: { conditionId: string; question: string; tokenId: string; outcome: string; shares: number; avgPrice: number; markPrice: N; unrealizedUsd: N }[];
  openOrders: { orderId: string; question: string; side: string; price: number; shares: number; filledShares: number; status: string; expiresAt: N }[];
  fills: { tradeId: string; question: string; side: string; price: number; shares: number; feeUsd: number; at: number }[];
  recon?: Recon;
};
export type KillResult = { cancelled: number; failed: { orderId: string; error: string }[] };

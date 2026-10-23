export type Level = { price: number; size: number };
export type Side = "YES" | "NO";
export type Tier = "small-cap" | "size";

export type Market = {
  conditionId: string;
  eventId: string;
  question: string;
  rules: string;
  category: string;
  tags: string[];
  endDate: number; // epoch ms
  negRiskGroup: string | null;
  negRiskAugmented?: boolean; // neg-risk event that can still gain outcomes: Σasks<1 is not a lock
  feeRate: number | null; // null = unknown, fall back by category
  feeExponent?: number | null; // Gamma feeSchedule.exponent; null/omitted = 1
  open: boolean;
  acceptingOrders: boolean;
  inDispute: boolean;
};

/** YES-token book. bids/asks in any order; helpers sort. */
export type Snapshot = {
  conditionId: string;
  ts: number; // epoch ms
  bids: Level[];
  asks: Level[];
  vol24h: number;
  oi: number;
  top10Share: number; // 0..1
  lastTradeTs: number | null;
  flowUnknown?: boolean; // trades fetch failed: lastTradeTs null means unknown, not "no trades"
};

export type ScreenResult = {
  conditionId: string;
  ts: number;
  R: number;
  I: number;
  L: number;
  T: number;
  C: number;
  /** Attention (factorA): 1 for a quiet market, down to 0.3 for a heavily traded one. In priority, not stored. */
  A: number;
  /** Rules nuance (factorN): 1 + 0.5 x rule ambiguity, 1 when unrated. In priority, not stored. */
  N: number;
  priority: number;
  tier: Tier;
  structural: boolean;
};

export type Thesis = {
  conditionId: string;
  podId: string;
  pHat: number;
  c: number;
  pPost: number;
  side: Side;
  edgeC: number;
  sizeUsd: number;
  rAnn: number;
  rank: number;
  catalysts: string[];
  killCriteria: string[];
  expiresAt: number;
};

/** Numeric core of a watchlist row, produced by sizing. */
export type WatchCore = {
  side: Side;
  pMid: number; // mid of the traded side's token
  pHat: number; // fair prob of the traded side's token
  c: number;
  pPost: number;
  k: number; // all-in cost per share at size S
  e: number; // pPost - k
  edgeC: number; // e in cents
  r: number;
  payoff: number;
  rAnn: number; // display-capped
  sizeUsd: number;
  shares: number;
  expectedProfit: number;
  daysLeft: number;
  rank: number;
};

export type WatchRow = WatchCore & { conditionId: string; nextCatalyst: string | null };

export type Settings = {
  filters: {
    minDays: number;
    maxDays: number;
    minDepthUsd: number;
    depthCents: number;
    excludedCategories: string[];
  };
  sizeTargets: { smallCap: number; size: number }; // USD
  slippageCents: number; // L fill window
  cCoef: number;
  crowdBonus: number;
  tDecayDays: number;
  bankroll: number;
  kelly: number;
  capFrac: number;
  minEdge: number;
  rAnnCap: number;
};

export const DEFAULT_SETTINGS: Settings = {
  filters: { minDays: 2, maxDays: 120, minDepthUsd: 200, depthCents: 5, excludedCategories: [] },
  sizeTargets: { smallCap: 200, size: 2000 },
  slippageCents: 3,
  cCoef: 0.5,
  crowdBonus: 0.2,
  tDecayDays: 60,
  bankroll: 1000, // placeholder: starting B is an open decision in SPEC
  kelly: 0.25,
  capFrac: 0.05,
  minEdge: 0.02,
  rAnnCap: 5,
};

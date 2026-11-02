/**
 * Tables of the Redis row store (store/). Same names, columns and types as the Postgres schema this replaced, so row shapes
 * (`typeof t.$inferSelect`) are unchanged. Indexes are sorted sets: `on` fields pick the set, `sort` orders it; there is no
 * query planner, so every filtered read goes through one of these (or a full scan on the small tables).
 *
 * Adding an index to an existing table: run `bun run db:reindex` (packages/db) once against each store so old rows join it.
 */
import { boolean, day, integer, json, num as dp, serial, table, text, timestamp as ts, uuid } from "./store/table";

const open = (r: { closedAt: Date | null }) => r.closedAt === null;

export const markets = table("markets", {
  conditionId: text().primaryKey(),
  eventId: text(),
  question: text().notNull(),
  category: text(),
  tags: json<string[]>().notNull().default([]),
  endDate: ts(),
  negRiskGroup: text(),
  feeRate: dp(), // null = unknown, callers fall back by category
  feeExponent: dp(), // Gamma feeSchedule.exponent (fee = rate * (p(1-p))^exponent); null = 1
  status: text().notNull().default("active"), // active | disputed | not_accepting | closed | resolved
  pmId: text(), // Gamma market id (for single-market lookups)
  yesTokenId: text(),
  noTokenId: text(),
  vol24h: dp(),
  tickSize: dp(), // null = unknown, callers fall back to 0.01
  liquidity: dp(),
  rulesHash: text(),
  heuristicR: dp(), // rules-text cue score from the sweep (screen R without the LLM); the text itself is fetched from Gamma on demand
  resolutionSource: text(), // official_data | scheduled_event | media_report | subjective | unknown
  negRiskAugmented: boolean().notNull().default(false),
}, {
  indexes: {
    status: { on: ["status"] },
    category: { on: ["category"] }, // distinct("category")
    negRisk: { on: ["negRiskGroup"], when: (r) => r.negRiskGroup !== null },
    event: { on: ["eventId"] },
  },
});

/** One row per market, updated in place by the snapshot job. */
export const marketLatest = table("market_latest", {
  conditionId: text().primaryKey(),
  ts: ts().notNull().defaultNow(),
  mid: dp(),
  bestBid: dp(),
  bestAsk: dp(),
  spread: dp(),
  depth1c: dp(),
  depth2c: dp(),
  depth5c: dp(),
  exitDepth: dp(),
  capacity: dp(),
  bookHash: text(),
  midChangedAt: ts(),
  holderCount: integer(),
  holderHhi: dp(),
  top1Share: dp(),
  top5Share: dp(),
  flow24h: dp(),
  tradeMedian: dp(),
  largeTrade24h: boolean(),
  lastTradeTs: ts(),
  priority: dp(), // latest screen score
  structural: json<string[]>(), // structural kinds this market is in
  opportunity: json<{ side: string; edge: number; stake: number; o: number; contrarian: boolean } | null>(),
}, {
  indexes: {
    byTs: { on: [], sort: "ts" },
    byPriority: { on: [], sort: "priority" },
    structural: { on: [], when: (r) => (r.structural?.length ?? 0) > 0 },
  },
});

export const views = table("views", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  query: text().notNull(),
  columns: json<string[]>().notNull().default([]),
  createdAt: ts().notNull().defaultNow(),
}, { indexes: { byCreated: { on: [], sort: "createdAt" } } });

export const alerts = table("alerts", {
  id: serial(),
  conditionId: text(),
  kind: text().notNull(), // mid_move | catalyst_passed | new_candidate | structural | run_failed
  message: text().notNull(),
  data: json<Record<string, unknown>>(),
  createdAt: ts().notNull().defaultNow(),
  ackedAt: ts(),
}, {
  indexes: {
    byCreated: { on: [], sort: "createdAt" },
    unacked: { on: [], sort: "createdAt", when: (r) => r.ackedAt === null },
    kindCond: { on: ["kind", "conditionId"], sort: "createdAt" }, // dedupe in code: same kind + market not re-raised within 6 h
    cond: { on: ["conditionId"], sort: "createdAt" },
  },
});

/** Per-thesis calibration row; filled by the calibrate job. */
export const journal = table("journal", {
  thesisId: text().primaryKey(),
  conditionId: text().notNull(),
  category: text(),
  model: text(),
  pHat: dp(),
  pPre: dp(), // mean of blind agent estimates
  midAt: dp(),
  liquidityAt: dp(),
  r: dp(),
  side: text(),
  stake: dp(),
  result: text(),
  resolvedAt: ts(),
  brierModel: dp(),
  brierMarket: dp(),
  brierPre: dp(),
  logLoss: dp(),
  drift24h: dp(),
  drift7d: dp(),
  paperPnl: dp(),
}, {
  indexes: {
    cond: { on: ["conditionId"] },
    resolved: { on: [], sort: "resolvedAt", when: (r) => r.resolvedAt !== null },
    unresolved: { on: [], when: (r) => r.resolvedAt === null },
    withResult: { on: [], when: (r) => r.result !== null },
  },
});

export type BookJson = { bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; netFlow: number; flowUnknown?: boolean };

export const snapshots = table("snapshots", {
  id: serial(),
  conditionId: text().notNull(),
  ts: ts().notNull().defaultNow(),
  mid: dp(),
  bestBid: dp(),
  bestAsk: dp(),
  depth5cUsd: dp(),
  vol24h: dp(),
  oi: dp(),
  top10Share: dp(),
  lastTradeTs: ts(),
  // YES-token levels kept for sizing/fills + 24h net taker flow (-1..1) for crowding
  book: json<BookJson>(),
}, {
  indexes: {
    cond: { on: ["conditionId"], sort: "ts" },
    /** Rows with a mid only (price history, 24 h change). */
    condMid: { on: ["conditionId"], sort: "ts", when: (r) => r.mid !== null },
    byTs: { on: [], sort: "ts" },
  },
});

export const screens = table("screens", {
  id: serial(),
  conditionId: text().notNull(),
  ts: ts().notNull().defaultNow(),
  r: dp(),
  i: dp(),
  l: dp(),
  t: dp(),
  c: dp(),
  priority: dp(),
  tier: text(),
  structuralFlag: boolean().notNull().default(false),
  structuralDetail: json<Record<string, unknown>>(),
}, {
  indexes: {
    cond: { on: ["conditionId"], sort: "ts" },
    /** All rows of one run (a run = one exact ts), by priority. */
    run: { on: ["ts"], sort: "priority" },
    byTs: { on: [], sort: "ts" },
    structural: { on: [], sort: "ts", when: (r) => r.structuralFlag },
  },
});

/** One row per completed screen run, written after all of the run's screens rows: the newest row is the "latest run" pointer. */
export const screenRuns = table("screen_runs", {
  ts: ts().primaryKey(),
  rows: integer().notNull(),
}, { indexes: { byTs: { on: [], sort: "ts" } } });

export const pods = table("pods", {
  id: text().primaryKey(),
  conditionId: text().notNull(),
  startedAt: ts().notNull().defaultNow(),
  status: text().notNull().default("running"), // running | ... | cancelled
  trigger: text().notNull(),
  costSandboxS: dp().notNull().default(0),
  profileId: text(), // research_profiles.id; null = screener / ad-hoc
  steering: json<Record<string, unknown>>(), // resolved steering that ran
  cancelRequestedAt: ts(),
  stage: text(), // rules | agents | judge | sizing | done
  error: text(), // why a failed pod failed (reason + scrubbed message), shown on the research desk
}, {
  indexes: {
    byStarted: { on: [], sort: "startedAt" },
    cond: { on: ["conditionId"], sort: "startedAt" },
    status: { on: ["status"], sort: "startedAt" },
    profile: { on: ["profileId"], sort: "startedAt" },
  },
});

/** Cheap pre-research verdict per market: primitive rules first, then a Haiku read of the question and rules. Newest row per market wins. */
export const triage = table("triage", {
  conditionId: text().primaryKey(),
  verdict: text().notNull(), // research | skip
  score: dp().notNull(), // 0..1, how much public research can move fair value
  reason: text().notNull(),
  failedRules: json<string[]>().notNull().default([]), // primitive rules that failed; non-empty = skipped without a model call
  model: text(), // null when the rules alone decided
  createdAt: ts().notNull().defaultNow(),
}, { indexes: { byCreated: { on: [], sort: "createdAt" }, verdict: { on: ["verdict"], sort: "createdAt" } } });

export const researchProfiles = table("research_profiles", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  enabled: boolean().notNull().default(false),
  filter: json<Record<string, unknown>>().notNull(),
  steering: json<Record<string, unknown>>().notNull(),
  everyMin: integer(),
  lastRunAt: ts(),
  createdAt: ts().notNull().defaultNow(),
  updatedAt: ts().notNull().defaultNow(),
}, { indexes: { byCreated: { on: [], sort: "createdAt" }, enabled: { on: ["enabled"], sort: "createdAt" } } });

export const agentRuns = table("agent_runs", {
  id: serial(),
  podId: text().notNull(),
  role: text().notNull(),
  model: text().notNull(),
  status: text().notNull(), // running | ok | ... | cancelled
  outputJson: json(),
  usage: json(),
  durationS: dp(),
  startedAt: ts(),
  finishedAt: ts(),
  toolCalls: json<{ ts: number; name: string; input: string; ok: boolean }[]>(), // input <= 500 chars, capped at 200 entries
}, {
  indexes: {
    pod: { on: ["podId"], sort: "id" },
    /** The finished judge run of a pod (its output is the verdict); lets pollers skip every agent's tool calls. */
    podJudgeOk: { on: ["podId"], sort: "id", when: (r) => r.role === "judge" && r.status === "ok" },
    status: { on: ["status"], sort: "id" },
  },
});

export const evidence = table("evidence", {
  id: serial(),
  podId: text().notNull(),
  agentRole: text().notNull(),
  url: text().notNull(),
  quote: text().notNull(),
  publishedAt: ts(),
  retrievedAt: ts().notNull().defaultNow(),
  claim: text().notNull(),
  direction: integer().notNull(), // +1 / -1
}, { indexes: { pod: { on: ["podId"], sort: "id" } } });

export const theses = table("theses", {
  id: text().primaryKey(),
  conditionId: text().notNull(),
  podId: text().notNull(),
  pHat: dp().notNull(),
  c: dp().notNull(),
  pPost: dp().notNull(),
  side: text().notNull(),
  edgeC: dp().notNull(),
  sizeUsd: dp().notNull(),
  rAnn: dp(),
  rank: dp(),
  catalysts: json<string[]>().notNull().default([]),
  killCriteria: json<string[]>().notNull().default([]),
  createdAt: ts().notNull().defaultNow(),
  expiresAt: ts(),
  // thesis text, YES-side pYes/pMidYes, k, shares, payoff, expectedProfit, daysLeft, capped, trigger
  detail: json<Record<string, unknown>>(),
}, {
  indexes: {
    byCreated: { on: [], sort: "createdAt" },
    cond: { on: ["conditionId"], sort: "createdAt" },
    pod: { on: ["podId"], sort: "createdAt" },
    /** expiresAt > now: range on this with gt: now. Null expiresAt rows are left out (see noExpiry). */
    byExpiry: { on: [], sort: "expiresAt", when: (r) => r.expiresAt !== null },
    noExpiry: { on: [], sort: "createdAt", when: (r) => r.expiresAt === null },
  },
});

export const outcomes = table("outcomes", {
  conditionId: text().primaryKey(),
  resolvedAt: ts().notNull(),
  result: text().notNull(),
  brier: dp(),
  logLoss: dp(),
}, { indexes: { byResolved: { on: [], sort: "resolvedAt" } } });

export const orders = table("orders", {
  id: text().primaryKey(),
  thesisId: text().notNull(),
  idempotencyKey: text().notNull().unique(),
  conditionId: text().notNull(),
  tokenId: text().notNull(),
  side: text().notNull(),
  limitPrice: dp().notNull(),
  size: dp().notNull(),
  modeAtSend: text().notNull(),
  approval: text(), // auto | user | null
  status: text().notNull(),
  clobOrderId: text(),
  expiresAt: ts(),
  paper: boolean().notNull().default(true),
  attempt: integer().notNull().default(0), // live key = `${thesisId}:${attempt}`; set legs: `set:${setId}:${leg}` / `set:${setId}:u${leg}` (unwind)
  createdAt: ts().notNull().defaultNow(),
  setId: uuid(), // neg-risk set leg (proposal_sets.id); thesisId = `set:${setId}` (sets are not theses)
  proposalId: uuid(), // single-leg order: the proposal that sent it (proposals.order_id points back)
}, {
  indexes: {
    /** Every order of one book (paper=true/false), by createdAt. */
    book: { on: ["paper"], sort: "createdAt" },
    /** By book and status (e.g. paper=false and status in LIVE_OPEN). */
    bookStatus: { on: ["paper", "status"], sort: "createdAt" },
    bookToken: { on: ["paper", "tokenId"], sort: "createdAt" },
    bookMode: { on: ["paper", "modeAtSend"], sort: "createdAt" },
    cond: { on: ["conditionId"], sort: "createdAt" },
    thesis: { on: ["thesisId"], sort: "createdAt" },
    thesisBook: { on: ["thesisId", "paper"], sort: "createdAt" },
    set: { on: ["setId"], sort: "createdAt", when: (r) => r.setId !== null },
    proposal: { on: ["proposalId"], when: (r) => r.proposalId !== null },
  },
});

export const fills = table("fills", {
  id: serial(),
  orderId: text().notNull(),
  ts: ts().notNull().defaultNow(),
  price: dp().notNull(),
  size: dp().notNull(),
  fee: dp().notNull().default(0),
  txHash: text(),
  paper: boolean().notNull().default(true),
  tradeId: text().unique(), // live exchange trade id; null for paper (multiple nulls allowed)
}, {
  indexes: {
    order: { on: ["orderId"], sort: "ts" },
    /** Every fill of one book (paper=true/false), by ts. */
    book: { on: ["paper"], sort: "ts" },
    /** Same, by id (insertion order). */
    bookById: { on: ["paper"], sort: "id" },
  },
});

export const positions = table("positions", {
  id: serial(),
  conditionId: text().notNull(),
  tokenId: text().notNull(),
  size: dp().notNull(),
  avgCost: dp().notNull(),
  realizedPnl: dp().notNull().default(0),
  openedAt: ts().notNull().defaultNow(),
  closedAt: ts(),
  paper: boolean().notNull().default(true),
}, {
  indexes: {
    /** Every position of one book, by id. */
    book: { on: ["paper"], sort: "id" },
    /** Open positions (closedAt null) of one book, by id. */
    open: { on: ["paper"], sort: "id", when: open },
    /** Closed positions of one book, by closedAt. */
    closed: { on: ["paper"], sort: "closedAt", when: (r) => !open(r) },
    bookToken: { on: ["paper", "tokenId"], sort: "id" },
    /** Open positions of one token in one book, by id. */
    openToken: { on: ["paper", "tokenId"], sort: "id", when: open },
    cond: { on: ["conditionId"], sort: "id" },
  },
});

/** Working manual paper orders: a limit that did not fill on arrival rests here; a stop waits for its trigger. Fills land in orders/fills/positions. */
export const paperOrders = table("paper_orders", {
  id: text().primaryKey(),
  conditionId: text().notNull(),
  tokenId: text().notNull(),
  outcome: text().notNull(), // YES | NO
  side: text().notNull(), // BUY | SELL
  kind: text().notNull(), // limit | stop
  limitPrice: dp(), // limit: fill at this price or better
  stopPrice: dp(), // stop: BUY triggers when the price rises to it, SELL when it falls to it; then fills at market
  usd: dp(), // BUY: dollars left to spend
  shares: dp(), // SELL: shares left to sell
  filledShares: dp().notNull().default(0),
  status: text().notNull().default("working"), // working | filled | cancelled
  reason: text(), // why it was cancelled
  createdAt: ts().notNull().defaultNow(),
  triggeredAt: ts(),
  bookTs: ts(), // the book it last looked at: the next fill or trigger check needs a newer one (a snapshot's levels count once)
  closedAt: ts(),
}, {
  indexes: {
    status: { on: ["status"], sort: "createdAt" },
    statusCond: { on: ["status", "conditionId"], sort: "createdAt" },
    /** Not working (filled/cancelled), by closedAt. */
    closed: { on: [], sort: "closedAt", when: (r) => r.status !== "working" },
    closedCond: { on: ["conditionId"], sort: "closedAt", when: (r) => r.status !== "working" },
    /** Markets with a working order: distinct("workingCond"). */
    workingCond: { on: ["conditionId"], when: (r) => r.status === "working" },
    cond: { on: ["conditionId"], sort: "createdAt" },
  },
});

export const autonomyEvents = table("autonomy_events", {
  id: serial(),
  ts: ts().notNull().defaultNow(),
  fromMode: text().notNull(),
  toMode: text().notNull(),
  scope: text().notNull().default("global"), // global | category:<name> | set:<id>
  reason: text().notNull(),
  actor: text().notNull(), // user | auto-downgrade | kill
}, {
  indexes: {
    byId: { on: [], sort: "id" },
    scope: { on: ["scope"], sort: "id" },
  },
});

// Extras the UI/actions need beyond SPEC's 12 tables.
export const settings = table("settings", {
  id: integer().primaryKey().default(1), // single row
  data: json().notNull(),
});

export const marketFlags = table("market_flags", {
  conditionId: text().primaryKey(),
  pinned: boolean().notNull().default(false),
  muted: boolean().notNull().default(false),
}, { indexes: { pinned: { on: [], when: (r) => r.pinned }, muted: { on: [], when: (r) => r.muted } } });

export const spend = table("spend", {
  day: day().primaryKey(),
  anthropicUsd: dp().notNull().default(0),
  exaCalls: integer().notNull().default(0),
  sandboxS: dp().notNull().default(0),
});

export const rrCache = table("rr_cache", {
  conditionId: text().notNull(),
  rulesHash: text().notNull(),
  r: dp().notNull(),
  detail: json(),
}, { pk: ["conditionId", "rulesHash"], indexes: { cond: { on: ["conditionId"] } } });

export const proposals = table("proposals", {
  id: uuid().primaryKey().defaultRandom(),
  thesisId: text().notNull(),
  conditionId: text().notNull(),
  tokenId: text().notNull(),
  side: text().notNull(), // BUY | SELL
  kind: text().notNull(), // entry | exit
  sizeUsd: dp().notNull(),
  shares: dp().notNull(),
  limitPrice: dp().notNull(),
  expectedProfit: dp().notNull(),
  priceAtProposal: dp().notNull(),
  createdAt: ts().notNull().defaultNow(),
  expiresAt: ts().notNull(),
  status: text().notNull().default("pending"), // pending | approved | rejected | expired | sent | failed
  decidedAt: ts(),
  decidedVia: text(), // web | tui | push
  approveTokenHash: text().notNull(), // sha256 hex
  rejectTokenHash: text().notNull(),
  orderId: text(), // orders.id
  error: text(),
  fallbackReason: text(), // L3 only: PER_TRADE | DAILY_AUTO_NOTIONAL | CATEGORY_NOT_ALLOWED (why it needs approval)
  exitReason: text(), // kind=exit: killed | flipped
}, {
  indexes: {
    byCreated: { on: [], sort: "createdAt" },
    status: { on: ["status"], sort: "createdAt" },
    /** By status, ordered by expiresAt (open proposals soonest-expiring first). */
    statusExpires: { on: ["status"], sort: "expiresAt" },
    /** By status, ordered by decidedAt (undecided rows sort first, like Postgres NULLS FIRST on desc). */
    statusDecided: { on: ["status"], sort: "decidedAt" },
    kindStatus: { on: ["kind", "status"], sort: "createdAt" },
    kindStatusDecided: { on: ["kind", "status"], sort: "decidedAt" },
    thesis: { on: ["thesisId"], sort: "createdAt" },
    cond: { on: ["conditionId"], sort: "createdAt" },
    order: { on: ["orderId"], when: (r) => r.orderId !== null },
  },
  unique: { onePendingPerThesis: { on: ["thesisId"], when: (r) => r.status === "pending" } },
});

export type SetLegRow = { conditionId: string; token: string; shares: number; limit: number; price: number }; // limit = FOK cap, price = touch at proposal

/** One neg-risk set = one approval, one risk check (build 3 decision 5). Legs live here, not as proposal rows, so single-leg decide/expire can never act on a leg. */
export const proposalSets = table("proposal_sets", {
  id: uuid().primaryKey().defaultRandom(),
  eventId: text().notNull(), // neg-risk group
  kind: text().notNull(), // buy-all | sell-all
  legs: json<SetLegRow[]>().notNull(), // send order (thinnest first)
  shares: dp().notNull(), // per leg
  totalCost: dp().notNull(),
  edge: dp().notNull(), // worst-case locked profit USD at the caps, after fees (= expected profit)
  status: text().notNull().default("pending"), // pending | sending | filled | unwinding | unwound | failed | flagged | acknowledged | rejected | expired
  createdAt: ts().notNull().defaultNow(),
  expiresAt: ts().notNull(),
  decidedAt: ts(),
  decidedVia: text(), // web | tui | push
  approveTokenHash: text().notNull(), // sha256 hex, "" = burned
  rejectTokenHash: text().notNull(),
  failedLeg: integer(), // 0-based index into legs
  error: text(),
  fallbackReason: text(), // L3 only: why the set needs approval (STRUCTURAL_AUTO_OFF | ...)
}, {
  indexes: {
    byCreated: { on: [], sort: "createdAt" },
    status: { on: ["status"], sort: "createdAt" },
    statusExpires: { on: ["status"], sort: "expiresAt" },
    statusDecided: { on: ["status"], sort: "decidedAt" },
    event: { on: ["eventId"], sort: "createdAt" },
  },
  unique: { onePendingPerEvent: { on: ["eventId"], when: (r) => r.status === "pending" } },
});

export const reconciliations = table("reconciliations", {
  id: serial(),
  at: ts().notNull().defaultNow(),
  ok: boolean().notNull(),
  baseline: boolean().notNull().default(false),
  positions: json<Record<string, number>>().notNull().default({}),
  usdcLedger: dp().notNull(),
  usdcExchange: dp().notNull(),
  mismatches: json<{ key: string; ledger: number; exchange: number }[]>().notNull().default([]),
}, {
  indexes: {
    byId: { on: [], sort: "id" },
    baseline: { on: [], sort: "id", when: (r) => r.baseline },
  },
});

/** Every table, keyed by the name handles use (`db.markets`, `db.proposalSets`, ...). */
export const tables = {
  markets, marketLatest, views, alerts, journal, snapshots, screens, screenRuns, pods, triage, researchProfiles, agentRuns, evidence,
  theses, outcomes, orders, fills, positions, paperOrders, autonomyEvents, settings, marketFlags, spend, rrCache, proposals, proposalSets,
  reconciliations,
};

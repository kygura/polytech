import { sql } from "drizzle-orm";
import { bigserial, boolean, date, doublePrecision as dp, index, integer, jsonb, pgTable, text, timestamp, primaryKey, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const markets = pgTable("markets", {
  conditionId: text("condition_id").primaryKey(),
  eventId: text("event_id"),
  question: text("question").notNull(),
  rules: text("rules").notNull().default(""),
  category: text("category"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  endDate: ts("end_date"),
  negRiskGroup: text("neg_risk_group"),
  feeRate: dp("fee_rate"), // null = unknown, callers fall back by category
  feeExponent: dp("fee_exponent"), // Gamma feeSchedule.exponent (fee = rate * (p(1-p))^exponent); null = 1
  status: text("status").notNull().default("active"), // active | disputed | not_accepting | closed | resolved
  pmId: text("pm_id"), // Gamma market id (for single-market lookups)
  yesTokenId: text("yes_token_id"),
  noTokenId: text("no_token_id"),
  vol24h: dp("vol_24h"),
  tickSize: dp("tick_size"), // null = unknown, callers fall back to 0.01
  liquidity: dp("liquidity"),
  rulesHash: text("rules_hash"),
  resolutionSource: text("resolution_source"), // official_data | scheduled_event | media_report | subjective | unknown
  negRiskAugmented: boolean("neg_risk_augmented").notNull().default(false),
});

/** One row per market, updated in place by the snapshot job. */
export const marketLatest = pgTable("market_latest", {
  conditionId: text("condition_id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  mid: dp("mid"),
  bestBid: dp("best_bid"),
  bestAsk: dp("best_ask"),
  spread: dp("spread"),
  depth1c: dp("depth_1c"),
  depth2c: dp("depth_2c"),
  depth5c: dp("depth_5c"),
  exitDepth: dp("exit_depth"),
  capacity: dp("capacity"),
  bookHash: text("book_hash"),
  midChangedAt: ts("mid_changed_at"),
  holderCount: integer("holder_count"),
  holderHhi: dp("holder_hhi"),
  top1Share: dp("top1_share"),
  top5Share: dp("top5_share"),
  flow24h: dp("flow_24h"),
  tradeMedian: dp("trade_median"),
  largeTrade24h: boolean("large_trade_24h"),
  lastTradeTs: ts("last_trade_ts"),
  priority: dp("priority"), // latest screen score
  structural: jsonb("structural").$type<string[]>(), // structural kinds this market is in
  opportunity: jsonb("opportunity").$type<{ side: string; edge: number; stake: number; o: number; contrarian: boolean } | null>(),
});

export const views = pgTable("views", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  query: text("query").notNull(),
  columns: jsonb("columns").$type<string[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conditionId: text("condition_id"),
  kind: text("kind").notNull(), // mid_move | catalyst_passed | new_candidate | structural | run_failed
  message: text("message").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  createdAt: ts("created_at").notNull().defaultNow(),
  ackedAt: ts("acked_at"),
}, (t) => [index("alerts_acked_created").on(t.ackedAt, t.createdAt)]); // dedupe in code: same kind + market not re-raised within 6 h

/** Per-thesis calibration row; filled by the calibrate job. */
export const journal = pgTable("journal", {
  thesisId: text("thesis_id").primaryKey(),
  conditionId: text("condition_id").notNull(),
  category: text("category"),
  model: text("model"),
  pHat: dp("p_hat"),
  pPre: dp("p_pre"), // mean of blind agent estimates
  midAt: dp("mid_at"),
  liquidityAt: dp("liquidity_at"),
  r: dp("r"),
  side: text("side"),
  stake: dp("stake"),
  result: text("result"),
  resolvedAt: ts("resolved_at"),
  brierModel: dp("brier_model"),
  brierMarket: dp("brier_market"),
  brierPre: dp("brier_pre"),
  logLoss: dp("log_loss"),
  drift24h: dp("drift_24h"),
  drift7d: dp("drift_7d"),
  paperPnl: dp("paper_pnl"),
});

export const snapshots = pgTable("snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conditionId: text("condition_id").notNull(),
  ts: ts("ts").notNull().defaultNow(),
  mid: dp("mid"),
  bestBid: dp("best_bid"),
  bestAsk: dp("best_ask"),
  depth5cUsd: dp("depth_5c_usd"),
  vol24h: dp("vol_24h"),
  oi: dp("oi"),
  top10Share: dp("top10_share"),
  lastTradeTs: ts("last_trade_ts"),
  // YES-token levels kept for sizing/fills + 24h net taker flow (-1..1) for crowding
  book: jsonb("book").$type<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; netFlow: number; flowUnknown?: boolean }>(),
}, (t) => [index("snapshots_cond_ts").on(t.conditionId, t.ts)]);

export const screens = pgTable("screens", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conditionId: text("condition_id").notNull(),
  ts: ts("ts").notNull().defaultNow(),
  r: dp("r"),
  i: dp("i"),
  l: dp("l"),
  t: dp("t"),
  c: dp("c"),
  priority: dp("priority"),
  tier: text("tier"),
  structuralFlag: boolean("structural_flag").notNull().default(false),
  structuralDetail: jsonb("structural_detail").$type<Record<string, unknown>>(),
}, (t) => [index("screens_cond_ts").on(t.conditionId, t.ts)]);

export const pods = pgTable("pods", {
  id: text("id").primaryKey(),
  conditionId: text("condition_id").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  status: text("status").notNull().default("running"), // running | ... | cancelled
  trigger: text("trigger").notNull(),
  costSandboxS: dp("cost_sandbox_s").notNull().default(0),
  profileId: text("profile_id"), // research_profiles.id; null = screener / ad-hoc
  steering: jsonb("steering").$type<Record<string, unknown>>(), // resolved steering that ran
  cancelRequestedAt: ts("cancel_requested_at"),
  stage: text("stage"), // rules | agents | judge | sizing | done
});

export const researchProfiles = pgTable("research_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  filter: jsonb("filter").$type<Record<string, unknown>>().notNull(),
  steering: jsonb("steering").$type<Record<string, unknown>>().notNull(),
  everyMin: integer("every_min"),
  lastRunAt: ts("last_run_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  podId: text("pod_id").notNull(),
  role: text("role").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(), // running | ok | ... | cancelled
  outputJson: jsonb("output_json"),
  usage: jsonb("usage"),
  durationS: dp("duration_s"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  toolCalls: jsonb("tool_calls").$type<{ ts: number; name: string; input: string; ok: boolean }[]>(), // input <= 500 chars, capped at 200 entries
});

export const evidence = pgTable("evidence", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  podId: text("pod_id").notNull(),
  agentRole: text("agent_role").notNull(),
  url: text("url").notNull(),
  quote: text("quote").notNull(),
  publishedAt: ts("published_at"),
  retrievedAt: ts("retrieved_at").notNull().defaultNow(),
  claim: text("claim").notNull(),
  direction: integer("direction").notNull(), // +1 / -1
});

export const theses = pgTable("theses", {
  id: text("id").primaryKey(),
  conditionId: text("condition_id").notNull(),
  podId: text("pod_id").notNull(),
  pHat: dp("p_hat").notNull(),
  c: dp("c").notNull(),
  pPost: dp("p_post").notNull(),
  side: text("side").notNull(),
  edgeC: dp("edge_c").notNull(),
  sizeUsd: dp("size_usd").notNull(),
  rAnn: dp("r_ann"),
  rank: dp("rank"),
  catalysts: jsonb("catalysts").$type<string[]>().notNull().default([]),
  killCriteria: jsonb("kill_criteria").$type<string[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
  // thesis text, YES-side pYes/pMidYes, k, shares, payoff, expectedProfit, daysLeft, capped, trigger
  detail: jsonb("detail").$type<Record<string, unknown>>(),
}, (t) => [index("theses_cond").on(t.conditionId)]);

export const outcomes = pgTable("outcomes", {
  conditionId: text("condition_id").primaryKey(),
  resolvedAt: ts("resolved_at").notNull(),
  result: text("result").notNull(),
  brier: dp("brier"),
  logLoss: dp("log_loss"),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  thesisId: text("thesis_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  conditionId: text("condition_id").notNull(),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(),
  limitPrice: dp("limit_price").notNull(),
  size: dp("size").notNull(),
  modeAtSend: text("mode_at_send").notNull(),
  approval: text("approval"), // auto | user | null
  status: text("status").notNull(),
  clobOrderId: text("clob_order_id"),
  expiresAt: ts("expires_at"),
  paper: boolean("paper").notNull().default(true),
  attempt: integer("attempt").notNull().default(0), // live key = `${thesisId}:${attempt}`; set legs: `set:${setId}:${leg}` / `set:${setId}:u${leg}` (unwind)
  createdAt: ts("created_at").notNull().defaultNow(),
  setId: uuid("set_id").references(() => proposalSets.id), // neg-risk set leg; thesisId = `set:${setId}` (sets are not theses)
  proposalId: uuid("proposal_id"), // single-leg order: the proposal that sent it (no FK: proposals.order_id already points back)
});

export const fills = pgTable("fills", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orderId: text("order_id").notNull(),
  ts: ts("ts").notNull().defaultNow(),
  price: dp("price").notNull(),
  size: dp("size").notNull(),
  fee: dp("fee").notNull().default(0),
  txHash: text("tx_hash"),
  paper: boolean("paper").notNull().default(true),
  tradeId: text("trade_id").unique(), // live exchange trade id; null for paper (multiple nulls allowed)
});

export const positions = pgTable("positions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conditionId: text("condition_id").notNull(),
  tokenId: text("token_id").notNull(),
  size: dp("size").notNull(),
  avgCost: dp("avg_cost").notNull(),
  realizedPnl: dp("realized_pnl").notNull().default(0),
  openedAt: ts("opened_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
  paper: boolean("paper").notNull().default(true),
});

export const autonomyEvents = pgTable("autonomy_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  fromMode: text("from_mode").notNull(),
  toMode: text("to_mode").notNull(),
  scope: text("scope").notNull().default("global"), // global | category:<name>
  reason: text("reason").notNull(),
  actor: text("actor").notNull(), // user | auto-downgrade | kill
});

// Extras the UI/actions need beyond SPEC's 12 tables.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1), // single row
  data: jsonb("data").notNull(),
});

export const marketFlags = pgTable("market_flags", {
  conditionId: text("condition_id").primaryKey(),
  pinned: boolean("pinned").notNull().default(false),
  muted: boolean("muted").notNull().default(false),
});

export const spend = pgTable("spend", {
  day: date("day").primaryKey(),
  anthropicUsd: dp("anthropic_usd").notNull().default(0),
  exaCalls: integer("exa_calls").notNull().default(0),
  sandboxS: dp("sandbox_s").notNull().default(0),
});

export const rrCache = pgTable("rr_cache", {
  conditionId: text("condition_id").notNull(),
  rulesHash: text("rules_hash").notNull(),
  r: dp("r").notNull(),
  detail: jsonb("detail"),
}, (t) => [primaryKey({ columns: [t.conditionId, t.rulesHash] })]);

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  thesisId: text("thesis_id").notNull(),
  conditionId: text("condition_id").notNull(),
  tokenId: text("token_id").notNull(),
  side: text("side").notNull(), // BUY | SELL
  kind: text("kind").notNull(), // entry | exit
  sizeUsd: dp("size_usd").notNull(),
  shares: dp("shares").notNull(),
  limitPrice: dp("limit_price").notNull(),
  expectedProfit: dp("expected_profit").notNull(),
  priceAtProposal: dp("price_at_proposal").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | expired | sent | failed
  decidedAt: ts("decided_at"),
  decidedVia: text("decided_via"), // web | tui | push
  approveTokenHash: text("approve_token_hash").notNull(), // sha256 hex
  rejectTokenHash: text("reject_token_hash").notNull(),
  orderId: text("order_id").references(() => orders.id),
  error: text("error"),
  fallbackReason: text("fallback_reason"), // L3 only: PER_TRADE | DAILY_AUTO_NOTIONAL | CATEGORY_NOT_ALLOWED (why it needs approval)
  exitReason: text("exit_reason"), // kind=exit: killed | flipped
}, (t) => [
  index("proposals_status").on(t.status),
  uniqueIndex("proposals_one_pending_per_thesis").on(t.thesisId).where(sql`${t.status} = 'pending'`),
]);

export type SetLegRow = { conditionId: string; token: string; shares: number; limit: number; price: number }; // limit = FOK cap, price = touch at proposal

/** One neg-risk set = one approval, one risk check (build 3 decision 5). Legs live here, not as proposal rows, so single-leg decide/expire can never act on a leg. */
export const proposalSets = pgTable("proposal_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: text("event_id").notNull(), // neg-risk group
  kind: text("kind").notNull(), // buy-all | sell-all
  legs: jsonb("legs").$type<SetLegRow[]>().notNull(), // send order (thinnest first)
  shares: dp("shares").notNull(), // per leg
  totalCost: dp("total_cost").notNull(),
  edge: dp("edge").notNull(), // worst-case locked profit USD at the caps, after fees (= expected profit)
  status: text("status").notNull().default("pending"), // pending | sending | filled | unwinding | unwound | failed | flagged | acknowledged | rejected | expired
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  decidedAt: ts("decided_at"),
  decidedVia: text("decided_via"), // web | tui | push
  approveTokenHash: text("approve_token_hash").notNull(), // sha256 hex, "" = burned
  rejectTokenHash: text("reject_token_hash").notNull(),
  failedLeg: integer("failed_leg"), // 0-based index into legs
  error: text("error"),
  fallbackReason: text("fallback_reason"), // L3 only: why the set needs approval (STRUCTURAL_AUTO_OFF | ...)
}, (t) => [
  index("proposal_sets_status").on(t.status),
  uniqueIndex("proposal_sets_one_pending_per_event").on(t.eventId).where(sql`${t.status} = 'pending'`),
]);

export const reconciliations = pgTable("reconciliations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  ok: boolean("ok").notNull(),
  baseline: boolean("baseline").notNull().default(false),
  positions: jsonb("positions").$type<Record<string, number>>().notNull().default({}),
  usdcLedger: dp("usdc_ledger").notNull(),
  usdcExchange: dp("usdc_exchange").notNull(),
  mismatches: jsonb("mismatches").$type<{ key: string; ledger: number; exchange: number }[]>().notNull().default([]),
});

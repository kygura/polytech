import { bigserial, boolean, date, doublePrecision as dp, index, integer, jsonb, pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

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
  status: text("status").notNull().default("active"), // active | disputed | not_accepting | closed | resolved
  pmId: text("pm_id"), // Gamma market id (for single-market lookups)
  yesTokenId: text("yes_token_id"),
  noTokenId: text("no_token_id"),
  vol24h: dp("vol_24h"),
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
  book: jsonb("book").$type<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; netFlow: number }>(),
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
  status: text("status").notNull().default("running"),
  trigger: text("trigger").notNull(),
  costSandboxS: dp("cost_sandbox_s").notNull().default(0),
});

export const agentRuns = pgTable("agent_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  podId: text("pod_id").notNull(),
  role: text("role").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  outputJson: jsonb("output_json"),
  usage: jsonb("usage"),
  durationS: dp("duration_s"),
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
});

export const fills = pgTable("fills", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orderId: text("order_id").notNull(),
  ts: ts("ts").notNull().defaultNow(),
  price: dp("price").notNull(),
  size: dp("size").notNull(),
  fee: dp("fee").notNull().default(0),
  txHash: text("tx_hash"),
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

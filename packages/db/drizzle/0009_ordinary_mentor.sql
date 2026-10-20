CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"thesis_id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"category" text,
	"model" text,
	"p_hat" double precision,
	"p_pre" double precision,
	"mid_at" double precision,
	"liquidity_at" double precision,
	"r" double precision,
	"side" text,
	"stake" double precision,
	"result" text,
	"resolved_at" timestamp with time zone,
	"brier_model" double precision,
	"brier_market" double precision,
	"brier_pre" double precision,
	"log_loss" double precision,
	"drift_24h" double precision,
	"drift_7d" double precision,
	"paper_pnl" double precision
);
--> statement-breakpoint
CREATE TABLE "market_latest" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"mid" double precision,
	"best_bid" double precision,
	"best_ask" double precision,
	"spread" double precision,
	"depth_1c" double precision,
	"depth_2c" double precision,
	"depth_5c" double precision,
	"exit_depth" double precision,
	"capacity" double precision,
	"book_hash" text,
	"mid_changed_at" timestamp with time zone,
	"holder_count" integer,
	"holder_hhi" double precision,
	"top1_share" double precision,
	"top5_share" double precision,
	"flow_24h" double precision,
	"trade_median" double precision,
	"large_trade_24h" boolean,
	"last_trade_ts" timestamp with time zone,
	"priority" double precision,
	"structural" jsonb,
	"opportunity" jsonb
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "views_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "liquidity" double precision;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "rules_hash" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "resolution_source" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "neg_risk_augmented" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pods" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pods" ADD COLUMN "stage" text;--> statement-breakpoint
CREATE INDEX "alerts_acked_created" ON "alerts" USING btree ("acked_at","created_at");
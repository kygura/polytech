CREATE TABLE "agent_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pod_id" text NOT NULL,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"output_json" jsonb,
	"usage" jsonb,
	"duration_s" double precision
);
--> statement-breakpoint
CREATE TABLE "autonomy_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"from_mode" text NOT NULL,
	"to_mode" text NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"pod_id" text NOT NULL,
	"agent_role" text NOT NULL,
	"url" text NOT NULL,
	"quote" text NOT NULL,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim" text NOT NULL,
	"direction" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"price" double precision NOT NULL,
	"size" double precision NOT NULL,
	"fee" double precision DEFAULT 0 NOT NULL,
	"tx_hash" text
);
--> statement-breakpoint
CREATE TABLE "market_flags" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"event_id" text,
	"question" text NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"category" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"end_date" timestamp with time zone,
	"neg_risk_group" text,
	"fee_rate" double precision,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"thesis_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"limit_price" double precision NOT NULL,
	"size" double precision NOT NULL,
	"mode_at_send" text NOT NULL,
	"approval" text,
	"status" text NOT NULL,
	"clob_order_id" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"brier" double precision,
	"log_loss" double precision
);
--> statement-breakpoint
CREATE TABLE "pods" (
	"id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"cost_sandbox_s" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"size" double precision NOT NULL,
	"avg_cost" double precision NOT NULL,
	"realized_pnl" double precision DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"paper" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rr_cache" (
	"condition_id" text NOT NULL,
	"rules_hash" text NOT NULL,
	"r" double precision NOT NULL,
	"detail" jsonb,
	CONSTRAINT "rr_cache_condition_id_rules_hash_pk" PRIMARY KEY("condition_id","rules_hash")
);
--> statement-breakpoint
CREATE TABLE "screens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"r" double precision,
	"i" double precision,
	"l" double precision,
	"t" double precision,
	"c" double precision,
	"priority" double precision,
	"tier" text,
	"structural_flag" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"mid" double precision,
	"best_bid" double precision,
	"best_ask" double precision,
	"depth_5c_usd" double precision,
	"vol_24h" double precision,
	"oi" double precision,
	"top10_share" double precision,
	"last_trade_ts" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "spend" (
	"day" date PRIMARY KEY NOT NULL,
	"anthropic_usd" double precision DEFAULT 0 NOT NULL,
	"exa_calls" integer DEFAULT 0 NOT NULL,
	"sandbox_s" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"pod_id" text NOT NULL,
	"p_hat" double precision NOT NULL,
	"c" double precision NOT NULL,
	"p_post" double precision NOT NULL,
	"side" text NOT NULL,
	"edge_c" double precision NOT NULL,
	"size_usd" double precision NOT NULL,
	"r_ann" double precision,
	"rank" double precision,
	"catalysts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kill_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "screens_cond_ts" ON "screens" USING btree ("condition_id","ts");--> statement-breakpoint
CREATE INDEX "snapshots_cond_ts" ON "snapshots" USING btree ("condition_id","ts");--> statement-breakpoint
CREATE INDEX "theses_cond" ON "theses" USING btree ("condition_id");
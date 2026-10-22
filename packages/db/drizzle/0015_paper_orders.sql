CREATE TABLE IF NOT EXISTS "paper_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"outcome" text NOT NULL,
	"side" text NOT NULL,
	"kind" text NOT NULL,
	"limit_price" double precision,
	"stop_price" double precision,
	"usd" double precision,
	"shares" double precision,
	"filled_shares" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"book_ts" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_orders_status_idx" ON "paper_orders" USING btree ("status","condition_id");
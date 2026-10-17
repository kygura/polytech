CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" text NOT NULL,
	"kind" text NOT NULL,
	"size_usd" double precision NOT NULL,
	"shares" double precision NOT NULL,
	"limit_price" double precision NOT NULL,
	"expected_profit" double precision NOT NULL,
	"price_at_proposal" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"approve_token_hash" text NOT NULL,
	"reject_token_hash" text NOT NULL,
	"order_id" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"usdc_ledger" double precision NOT NULL,
	"usdc_exchange" double precision NOT NULL,
	"mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fills" ADD COLUMN "paper" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paper" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_status" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_pending_per_thesis" ON "proposals" USING btree ("thesis_id") WHERE "proposals"."status" = 'pending';
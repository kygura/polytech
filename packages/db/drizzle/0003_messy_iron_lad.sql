ALTER TABLE "fills" ADD COLUMN "trade_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_trade_id_unique" UNIQUE("trade_id");
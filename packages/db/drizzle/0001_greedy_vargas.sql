ALTER TABLE "markets" ADD COLUMN "pm_id" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "yes_token_id" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "no_token_id" text;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "vol_24h" double precision;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "structural_detail" jsonb;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "book" jsonb;--> statement-breakpoint
ALTER TABLE "theses" ADD COLUMN "detail" jsonb;
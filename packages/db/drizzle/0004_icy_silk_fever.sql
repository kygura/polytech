ALTER TABLE "reconciliations" ADD COLUMN "baseline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD COLUMN "positions" jsonb DEFAULT '{}'::jsonb NOT NULL;
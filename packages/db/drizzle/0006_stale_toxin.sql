ALTER TABLE "orders" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "proposal_sets" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "exit_reason" text;
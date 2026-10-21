CREATE TABLE IF NOT EXISTS "triage" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"score" double precision NOT NULL,
	"reason" text NOT NULL,
	"failed_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pods" ADD COLUMN IF NOT EXISTS "error" text;
CREATE TABLE "research_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"filter" jsonb NOT NULL,
	"steering" jsonb NOT NULL,
	"every_min" integer,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "pods" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "pods" ADD COLUMN "steering" jsonb;
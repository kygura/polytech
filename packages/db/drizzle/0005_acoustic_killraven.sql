CREATE TABLE "proposal_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"legs" jsonb NOT NULL,
	"shares" double precision NOT NULL,
	"total_cost" double precision NOT NULL,
	"edge" double precision NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"approve_token_hash" text NOT NULL,
	"reject_token_hash" text NOT NULL,
	"failed_leg" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "set_id" uuid;--> statement-breakpoint
CREATE INDEX "proposal_sets_status" ON "proposal_sets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_sets_one_pending_per_event" ON "proposal_sets" USING btree ("event_id") WHERE "proposal_sets"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_set_id_proposal_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."proposal_sets"("id") ON DELETE no action ON UPDATE no action;
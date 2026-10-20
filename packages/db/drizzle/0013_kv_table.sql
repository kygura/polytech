CREATE TABLE IF NOT EXISTS "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"expires_at" timestamp with time zone
);

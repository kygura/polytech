-- Supabase advisor 0013: triage and paper_orders were readable/writable by anon and
-- authenticated through PostgREST. The app connects over DATABASE_URL as the owner
-- (bypasses RLS), so RLS with no policies closes the API surface and changes nothing for it.
ALTER TABLE IF EXISTS "triage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "paper_orders" ENABLE ROW LEVEL SECURITY;

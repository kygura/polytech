# CLAUDE.md

## Database migrations

Any change to `packages/db/src/schema.ts` ships with its migration, and the migration gets applied to production without being asked.

1. Generate it: `cd packages/db && npx drizzle-kit generate --name <snake_case>`. Commit the `.sql`, `meta/_journal.json` and `meta/NNNN_snapshot.json` together. Use `IF NOT EXISTS` on `CREATE TABLE` / `CREATE INDEX` / `ADD COLUMN`, like the earlier migrations.
2. Apply it to production: the Supabase project `polytech` (id `yocphnzilmbnfsueqemn`, eu-north-1). Production has `DATABASE_URL` set, so the app does not migrate itself on start (only PGlite does).
   - With `DATABASE_URL` available: `cd packages/db && bun run db:migrate`.
   - Otherwise, through the Supabase MCP: `apply_migration` with the file's SQL (drop the `--> statement-breakpoint` lines), plus a row in drizzle's bookkeeping in the same call, so a later `db:migrate` skips it:
     ```sql
     INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
     SELECT '<sha256sum of the .sql file>', <"when" from meta/_journal.json>
     WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = <when>);
     ```
3. Check it landed (the table or columns exist, and `max(created_at)` in `drizzle.__drizzle_migrations` equals the new `when`), then say so in the reply.

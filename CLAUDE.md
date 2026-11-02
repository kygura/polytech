# CLAUDE.md

## Database migrations

Any change to `packages/db/src/schema.ts` ships with its migration, and the migration gets applied to production without being asked.

1. Generate it: `cd packages/db && npx drizzle-kit generate --name <snake_case>` (dialect `turso`). Commit the `.sql`, `meta/_journal.json` and `meta/NNNN_snapshot.json` together. Add `IF NOT EXISTS` to `CREATE TABLE` / `CREATE INDEX` by hand, like the earlier migrations (SQLite has no `ADD COLUMN IF NOT EXISTS`). SQLite's `ALTER TABLE` only adds, renames and drops columns, so for other changes (type, `NOT NULL`, default, constraint, FK) drizzle-kit rebuilds the table (`PRAGMA foreign_keys=OFF`, `__new_<table>`, `INSERT ... SELECT`, `DROP`, `RENAME`): review it. On a table with rows, `ADD COLUMN` fails with a non-constant default (`nowMs`) or with `NOT NULL` and no constant default; tests migrate an empty `:memory:` db and won't catch it.
2. Apply it to production: the Turso database `polytech` (its group sits in the Turso location nearest Vercel's `arn1`, Stockholm). Production has `TURSO_DATABASE_URL` set, so the app does not migrate itself on start (only the local file does).
   - With the credentials: `cd packages/db && TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:migrate` (one transaction).
   - Otherwise with the Turso CLI: `turso db shell polytech < packages/db/drizzle/NNNN_<name>.sql` (the `--> statement-breakpoint` markers are SQL comments), plus a row in drizzle's bookkeeping so a later `db:migrate` skips it. The libsql migrator keeps `__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)` in the main database (no `drizzle` schema; `id` stays NULL), reads only its newest row (`ORDER BY created_at DESC LIMIT 1`) and runs every journal entry whose `when` is larger; it never compares hashes.
     ```sql
     CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
     INSERT INTO __drizzle_migrations (hash, created_at)
     SELECT '<sha256sum of the .sql file>', <"when" from meta/_journal.json>
     WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE created_at = <when>);
     ```
3. Check it landed (`PRAGMA table_info(<table>)` shows the table or columns, and `SELECT max(created_at) FROM __drizzle_migrations` equals the new `when`), then say so in the reply.

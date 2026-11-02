# CLAUDE.md

## Database migrations

Any change to `packages/db/src/schema.ts` ships with its migration, and the migration gets applied to production without being asked.

1. Generate it: `cd packages/db && npx drizzle-kit generate --name <snake_case>` (dialect `turso`). Commit the `.sql`, `meta/_journal.json` and `meta/NNNN_snapshot.json` together. By hand, add `IF NOT EXISTS` to every `CREATE TABLE` / `CREATE [UNIQUE] INDEX` and `IF EXISTS` to every `DROP INDEX`, like the earlier migrations (SQLite has no `ADD COLUMN IF NOT EXISTS`; `db.test.ts` checks it). Review what drizzle-kit wrote: tests migrate an empty `:memory:` db and catch none of this.
   - A type, `NOT NULL` or default change on a column that is not a PK or FK, and a new single-column FK, become libSQL's `ALTER TABLE t ALTER COLUMN "c" TO "c" ...`, between a `DROP INDEX` and a `CREATE INDEX` of every index in the database (the unique guards too). That ALTER only rewrites the declared column and checks no existing row: `NOT NULL` over existing NULLs succeeds and keeps them, a type change converts no stored value, a new FK isn't checked. Before tightening, put a backfill above the ALTER (`UPDATE t SET c = ... WHERE c IS NULL;`) and check `SELECT count(*) FROM t WHERE c IS NULL` in production.
   - PK, autoincrement, check-constraint and FK-drop changes, a multi-column FK, and a type / `NOT NULL` / default change on a PK or FK column rebuild the table (`PRAGMA foreign_keys=OFF`, `__new_<table>`, `INSERT ... SELECT`, `DROP`, `RENAME`); a NULL left in a column made `NOT NULL` fails the `INSERT ... SELECT`.
   - On a table with rows, `ADD COLUMN` fails with a non-constant default (`nowMs`) or with `NOT NULL` and no constant default.
2. Apply it to production: the Turso database behind the Vercel Turso integration (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` live in Vercel's env, preview and production share it). Production builds apply pending migrations before `turbo run build` (`apps/web/scripts/migrate-deploy.ts`, run by the `buildCommand` in `apps/web/vercel.json`); preview builds never migrate. So the merge to master applies it; the app never migrates the hosted database on start (only the local file does).
   - Without a production deploy, with the credentials (`vercel env pull`): `cd packages/db && TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:migrate` (one transaction). Unset `DB_FILE` first: it wins over `TURSO_DATABASE_URL`.
   - Otherwise with the Turso CLI, only for a migration with no `DROP INDEX` (it runs statement by statement, so the app would run without the dropped indexes, unique guards included, and a failing `CREATE UNIQUE INDEX` leaves one gone): `turso db shell polytech < packages/db/drizzle/NNNN_<name>.sql` (the `--> statement-breakpoint` markers are SQL comments), plus a row in drizzle's bookkeeping so a later `db:migrate` skips it. The libsql migrator keeps `__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)` in the main database (no `drizzle` schema; `id` stays NULL), reads only its newest row (`ORDER BY created_at DESC LIMIT 1`) and runs every journal entry whose `when` is larger; it never compares hashes.
     ```sql
     CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
     INSERT INTO __drizzle_migrations (hash, created_at)
     SELECT '<sha256sum of the .sql file>', <"when" from meta/_journal.json>
     WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations WHERE created_at = <when>);
     ```
3. Check it landed (the production build log says `db: migrations applied to the hosted database`; `PRAGMA table_info(<table>)` shows the table or columns, and `SELECT max(created_at) FROM __drizzle_migrations` equals the new `when`; after an `ALTER COLUMN`, `PRAGMA quick_check` says `ok` and `PRAGMA foreign_key_check` returns no row), then say so in the reply.

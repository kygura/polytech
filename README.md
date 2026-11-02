# polytech

Polymarket edge engine. It scans open Polymarket markets, scores where public research can beat the crowd price, sends an agent fleet to research the top candidates, and ranks survivors by projected return per unit of risk. Output is a watchlist with a thesis, fair probability, edge and suggested size. Trades are placed on the Polymarket CLOB, gated by an autonomy mode and hard risk limits.

## Layout

Bun workspaces + Turborepo.

```
apps/web       Next.js App Router: dashboard, /trade terminal, cron routes
apps/tui       Ink terminal client (`pm`)
packages/core  book, calibration, autonomy, risk-limit checks
packages/pm    Polymarket clients, exchange, fixtures
packages/agents  research pods, judge, sizing
packages/db    Drizzle schema (libSQL via TURSO_DATABASE_URL, e.g. Turso; local file .data/polytech.db when unset)
```

## Run

```bash
bun install
bun run dev         # turbo dev (apps/web: next dev)
bun run build
bun run test        # vitest via turbo
bun run typecheck
cd apps/tui && bun run start    # TUI
```

Copy `.env.example` for keys. Research agents need only `ANTHROPIC_API_KEY`: they run on the Messages API with Anthropic's hosted web search and fetch. Without a key, local runs fall back to a deterministic fake research runner; production refuses it. Fixtures stand in for Polymarket when it is unreachable (`PM_FIXTURES=1`).

## Docs

- [`SPEC.md`](SPEC.md): build spec; Rev 9 (research desk, paper trading, simple terminal) is the latest section.
- [`DESIGN.md`](DESIGN.md): design brief.
- [`TASKS.md`](TASKS.md): task log of the original phase 1-5 build.
- [`docs/`](docs): API notes, research profiles, design mockups.

## Status

Live trading has shipped. In `git log`:

- Order flow including SELL, per-market tick size, unknown-outcome handling and allowance retry (6ca48ec, c6dc99c, 61106a0).
- Visitor wallets: browser wallets with a browser-held autonomy key (SPEC.md Rev 6) (6867900, 311f2cd).
- `/trade` single-screen trading terminal with live market feed (5f953f2, f293e72).
- Research profiles, market name search, sweep and pod timeout fixes (a1d4016).

`TASKS.md` describes the original phase 1-5 build and is outdated where it says execution is refused server-side and no wallet key handling exists. Rev 6 of `SPEC.md` is current.

## Paused

The project is paused on Vercel and in GitHub Actions, and its database has moved from Supabase (Postgres) to Turso (libSQL). Resume in this order, so nothing runs against a missing or empty database:

1. Turso: the `polytech` database exists and is migrated: `cd packages/db && TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:migrate`. To keep the Supabase data, copy it now (next section).
2. Vercel env: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set, `DATABASE_URL` removed. With no Upstash vars, locks and rate limits use the database's `kv` table.
3. Vercel: unpause the `polytech` project from its dashboard. This brings back the site and the daily crons in `apps/web/vercel.json`.
4. GitHub Actions: in `.github/workflows/scout.yml`, put back the commented `schedule:` block (`*/30 * * * *`); in `.github/workflows/ci.yml`, put back the `push:` and `pull_request:` triggers. Keep `workflow_dispatch:` in both.

## Moving data off Supabase

`packages/db/scripts/copy-from-postgres.ts` copies the old Postgres data into the libSQL database, once. The Supabase project `polytech` (`yocphnzilmbnfsueqemn`) is paused: restore it from its dashboard and take its session-pooler or direct connection string (not the transaction pooler).

```bash
cd packages/db
PG_URL=postgresql://... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:copy-from-postgres
```

It migrates the target, then reads every schema table from the Postgres table of the same name (referenced tables first) and inserts in chunks with `ON CONFLICT DO NOTHING`, so a rerun only adds missing rows. Timestamps become epoch ms, `date` becomes `YYYY-MM-DD`, bigint ids become numbers, jsonb becomes JSON text; Postgres columns the schema no longer has are left behind with a warning. It ends with per-table counts (Postgres, before, inserted, after) and exits 1 if a table has fewer rows than its source. Run it before step 3: once the app writes to Turso, a Postgres row whose id is already taken there is skipped. Without `TURSO_DATABASE_URL` it fills the local file instead, which makes a dry run. Once the counts match, Supabase can be paused again.

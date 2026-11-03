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

GitHub Actions is manual only (scout, CI); the daily Vercel crons run the scouting pass. The database has moved from Supabase (Postgres, now paused) to Turso (libSQL), connected to the Vercel project by the Turso integration, which sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for preview and production. Turso starts empty: the first scout kick sweeps the markets back in; the Supabase theses, journal and paper book are not carried over (to carry them over, see the next section, before step 2). Resume in this order, so nothing runs against a missing or unmigrated database:

1. Vercel env: the two Turso vars present; remove `DATABASE_URL` and the Supabase integration's `POSTGRES_*` / `SUPABASE_*` vars (nothing reads them now). With no Upstash vars, locks and rate limits use the database's `kv` table.
2. Deploy this commit to production (merge it to master). Production builds migrate Turso before building (`apps/web/scripts/migrate-deploy.ts`, the `buildCommand` in `apps/web/vercel.json`), and the build log must say `db: migrations applied to the hosted database`; anything else means it didn't see `TURSO_DATABASE_URL`. Env changes only reach new deployments: a dashboard Redeploy of the old production deployment rebuilds the Postgres code.
3. Check that the production deployment is this commit's and `/api/status` answers.
4. Scouting cadence: the Vercel crons in `apps/web/vercel.json` run the daily pass (01:00 sweep, 02:00 every kept market's book, 03:00 screen, 04:00 research, 05:00 calibrate, 05:30 alerts, UTC). A read of `/api/public/watchlist` refreshes the watchlist books at most once an hour, never the sweep, screen or research (Vercel Hobby caps Fluid Active CPU at 4 h/month) (`apps/web/lib/jobs/kick.ts`); so does a manual `scout` dispatch. Nothing polls on a schedule from GitHub. The market page's live book streams from the CLOB WebSocket regardless. CI is manual: put back `push:` / `pull_request:` in `.github/workflows/ci.yml` to resume it.

## Later: an always-on worker for fast markets

The agents and stored snapshots run on a daily cadence (Vercel Hobby crons) plus traffic kicks, so a market that moves or resolves within hours is out of sync for the desk; only the market page's live book is real-time (CLOB WebSocket in the browser). If fast-resolution or news-driven markets prove worth trading, move the scouting loop to a small always-on worker on Railway or Fly (~$5/month): hold the CLOB WebSocket, re-screen on price moves and new listings within seconds, write to the same Turso database. GitHub Actions or a tighter cron does not fix this; polling at any interval lags a socket.

## Moving data off Supabase

`packages/db/scripts/copy-from-postgres.ts` copies the old Postgres data into the libSQL database, once. The Supabase project `polytech` (`yocphnzilmbnfsueqemn`) is paused: restore it from its dashboard and take its session-pooler or direct connection string (not the transaction pooler).

```bash
cd packages/db
PG_URL=postgresql://... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... bun run db:copy-from-postgres
```

It migrates the target, then reads every schema table from the Postgres table of the same name (referenced tables first) and inserts in chunks with `ON CONFLICT DO NOTHING`, so a rerun only adds missing rows. Timestamps become epoch ms, `date` becomes `YYYY-MM-DD`, bigint ids become numbers, jsonb becomes JSON text; Postgres columns the schema no longer has are left behind with a warning. It ends with per-table counts (Postgres, before, inserted, after) and exits 1 if a table has fewer rows than its source. Run it after a migrate and before step 2's deploy: once the app writes to Turso, a Postgres row whose id is already taken there is skipped (and still counts as present). Without `TURSO_DATABASE_URL` it fills the local file instead, which makes a dry run. Pause Supabase again once the counts match.

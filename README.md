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
packages/db    Redis row store + kv (Upstash in production; any Redis via REDIS_URL; in-process when unset). See packages/db/README.md
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

Copy `.env.example` for keys. Without Redis settings the app keeps its data in-process, saved to `.data/store.json`; set `REDIS_URL=redis://localhost:6379` to share one store between `next dev`, the TUI's server and scripts. Research agents need only `ANTHROPIC_API_KEY`: they run on the Messages API with Anthropic's hosted web search and fetch. Without a key, local runs fall back to a deterministic fake research runner; production refuses it. Fixtures stand in for Polymarket when it is unreachable (`PM_FIXTURES=1`).

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

## Datastore move: Supabase -> Redis

The app no longer uses Postgres. Its data lives in Redis (Upstash on Vercel) through `packages/db` (see `packages/db/README.md`).
The old Supabase project (`polytech`, `yocphnzilmbnfsueqemn`) is paused and untouched; it holds the data from before the move.

Cutover, once:

1. Vercel: add an Upstash Redis database to the `polytech` project (Storage -> Upstash for Redis, region close to `arn1`), or set
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` yourself. Remove `DATABASE_URL`; nothing reads it now.
2. Copy the old data (optional; skip to start empty). Restore the Supabase project, then with its connection string and the
   Upstash credentials in the env: `cd packages/db && PG_URL=... bun run db:import-pg --dry-run`, then without `--dry-run`.
   It prints per-table counts and refuses to write into a store that already has data. Pause Supabase again afterwards, or delete it.
3. Unpause the Vercel project and resume the schedules (below).

## Paused

The project is paused in two places. Resume in this order:

1. Vercel: unpause the `polytech` project from its dashboard (with the Upstash credentials set: production refuses to start without a shared store). This brings back the site and the daily crons in `apps/web/vercel.json`.
2. GitHub Actions: in `.github/workflows/scout.yml`, put back the commented `schedule:` block (`*/30 * * * *`); in `.github/workflows/ci.yml`, put back the `push:` and `pull_request:` triggers. Keep `workflow_dispatch:` in both.

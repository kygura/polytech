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
packages/db    Drizzle schema (Postgres via DATABASE_URL, e.g. Supabase; PGlite when unset)
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

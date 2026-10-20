# Rev 8 audit

Status of every finding from the Rev 8 audit. "UI pass" = owned by the parallel UI rewrite (C1 terminal, C2 screener/markets, C3 journal/runs/research); not part of this change.

| # | Finding | Severity | Status | Notes |
|---|---------|----------|--------|-------|
| 1 | In `next dev` RSC pages and route handlers get separate module instances, so the `db`/`migrator`/`closer` singletons (`packages/db/src/client.ts`) and the `getKv` singleton (`packages/db/src/kv.ts`) were duplicated: SSR read a different PGlite than `/api`, a second PGlite on the same dir aborted on `CREATE SCHEMA "drizzle"` and corrupted it, 4 GB RSS | Blocker | Fixed in Rev 8 | State now lives on `globalThis` (`__pmDb`, `__pmKv`), one PGlite per process per dir. Same treatment for `dbReady` (`lib/jobs/deps.ts`, `__pmReady`) and the `memo` cache (`lib/jobs/memo.ts`, `__pmMemo`) so `memoClear` from a write reaches the reader's store. The Postgres (`DATABASE_URL`) path is unchanged. Test: `packages/db/src/db.test.ts` "separate module instances share one db and one kv" |
| 2 | `kick.ts` called `scoutChain()` (a `"use workflow"` function) directly outside Vercel: "You attempted to execute workflow scoutChain function directly" | Major | Fixed in Rev 8 | `runChain()` runs the same steps in the same order with the same per-step catch, without the workflow wrapper; `startChain` uses it off Vercel or with `WORKFLOW_INLINE=1`. `scoutChain` shares the step list (`runSteps`). Tests: `lib/jobs/kick.test.ts` (order, a failing step does not block the rest) |
| 3 | Stale banner always on: `STALE_MS` 5 min vs a snapshot that only runs with the 30 min scout kick | Major | Fixed in Rev 8 | One source: `lib/cadence.ts` `SCOUT_KICK_MS` = 30 min, `STALE_MS` = 2x that. `kick.ts` uses the former, `StaleBanner` re-exports the latter, `SNAPSHOT_CADENCE_MS` (status bar tone) = `SCOUT_KICK_MS`. Test: `lib/cadence.test.ts` |
| 4 | Category null for every market | Major | Fixed in Rev 8 | Gamma `/markets/keyset` has no `category` and returns no `tags` unless `include_tag=true`; `marketParams` now sends it (`packages/pm/src/index.ts`). The existing mapping (known category slug, else first tag) then fills `category`/`tags` in `toMarketRow`. Tests: `packages/pm/src/pm.test.ts` (query param + a real keyset row fixture). Existing databases pick it up on the next sweep (the upsert rewrites rows whose category/tags changed) |
| 5 | No favicon, 404 on every page | Minor | Fixed in Rev 8 | `apps/web/app/icon.svg`, "PM" monogram, `#9d8cff` on `#0b0d10` |
| 6 | First `g` chord dead | Major | Fixed in Rev 8 | Shell rewrite: module-level `pendingG` |
| 7 | Terminal search only filtered shortlisted rows | Major | Owned by UI pass | C1 |
| 8 | Chart: one-point flat line, duplicate y ticks | Minor | Fixed in Rev 8 | `ProbChart` |
| 9 | Wide-book mid shows 42c vs list 5.5c | Major | Owned by UI pass | C1: show the last trade when the spread is wide (Polymarket convention) |
| 10 | `/trade/autonomy` hits `/trade/[id]` with `id=autonomy` | Minor | Owned by UI pass | C1 |
| 11 | Double stale banner on `/markets/[id]` | Minor | Moot | `/markets/[id]` redirects to `/trade/[id]` |
| 12 | `/markets` horizontal overflow | Minor | Owned by UI pass | C2 |
| 13 | Terminal disclaimer overlaps the list | Minor | Owned by UI pass | C1 |
| 14 | ActionBar key hints glued to labels | Minor | Owned by UI pass | C1 |
| 15 | Journal drift panel blank | Minor | Owned by UI pass | C3 |
| 16 | Transient hydration error on `/autonomy` | Minor | Not reproducible | Re-open with a stack if it returns |
| 17 | Dead visitor code: `lib/visitor/tradingKey.ts`, `lib/visitor/autonomy.ts` (+ tests) | Cleanup | Fixed in Rev 8 | Zero non-test importers (grep), deleted with `autonomy.test.ts`; the visitor settings tests moved to `visitor.test.ts`. Left: `toAppSettings` in `lib/visitor/settings.ts` is now unused (was only the deleted loop's); trivial to drop later |
| 18 | `/api/public/*` routes duplicate `/api/markets` | Cleanup | Deferred | Kept as the terminal's read API (`TerminalPage`, `useMarketFeed`; `proxy.ts` keeps it GET/HEAD-only). Merge with `/api/markets` once the terminal is stable |
| 19 | `app/api/pm` relay | Cleanup | Kept | Used: `lib/visitor/relay.ts` -> `wallet.ts` / `exchange.ts` -> `hooks/useWallet.ts` (browser wallet reaches Polymarket through it) |

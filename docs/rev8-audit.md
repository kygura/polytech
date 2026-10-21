# Rev 8 audit

Status of every finding from the Rev 8 audit (route sweep), the code review and the design drift check. Every row is fixed in Rev 8 unless it says otherwise.

| # | Finding | Severity | Status | Notes |
|---|---------|----------|--------|-------|
| 1 | In `next dev` RSC pages and route handlers get separate module instances, so the `db`/`migrator`/`closer` singletons (`packages/db/src/client.ts`) and the `getKv` singleton (`packages/db/src/kv.ts`) were duplicated: SSR read a different PGlite than `/api`, a second PGlite on the same dir aborted on `CREATE SCHEMA "drizzle"` and corrupted it, 4 GB RSS | Blocker | Fixed in Rev 8 | State now lives on `globalThis` (`__pmDb`, `__pmKv`), one PGlite per process per dir. Same treatment for `dbReady` (`lib/jobs/deps.ts`, `__pmReady`) and the `memo` cache (`lib/jobs/memo.ts`, `__pmMemo`) so `memoClear` from a write reaches the reader's store. The Postgres (`DATABASE_URL`) path is unchanged. Test: `packages/db/src/db.test.ts` "separate module instances share one db and one kv" |
| 2 | `kick.ts` called `scoutChain()` (a `"use workflow"` function) directly outside Vercel: "You attempted to execute workflow scoutChain function directly" | Major | Fixed in Rev 8 | `runChain()` runs the same steps in the same order with the same per-step catch, without the workflow wrapper; `startChain` uses it off Vercel or with `WORKFLOW_INLINE=1`. `scoutChain` shares the step list (`runSteps`). Tests: `lib/jobs/kick.test.ts` (order, a failing step does not block the rest) |
| 3 | Stale banner always on: `STALE_MS` 5 min vs a snapshot that only runs with the 30 min scout kick | Major | Fixed in Rev 8 | One source: `lib/cadence.ts` `SCOUT_KICK_MS` = 30 min, `STALE_MS` = 2x that. `kick.ts` uses the former, `StaleBanner` re-exports the latter, `SNAPSHOT_CADENCE_MS` (status bar tone) = `SCOUT_KICK_MS`. Test: `lib/cadence.test.ts` |
| 4 | Category null for every market | Major | Fixed in Rev 8 | Gamma `/markets/keyset` has no `category` and returns no `tags` unless `include_tag=true`; `marketParams` now sends it (`packages/pm/src/index.ts`). The existing mapping (known category slug, else first tag) then fills `category`/`tags` in `toMarketRow`. Tests: `packages/pm/src/pm.test.ts` (query param + a real keyset row fixture). Existing databases pick it up on the next sweep (the upsert rewrites rows whose category/tags changed) |
| 5 | No favicon, 404 on every page | Minor | Fixed in Rev 8 | `apps/web/app/icon.svg`, "PM" monogram, `#9d8cff` on `#0b0d10` |
| 6 | First `g` chord dead | Major | Fixed in Rev 8 | Shell rewrite: module-level `pendingG` |
| 7 | Terminal search only filtered shortlisted rows | Major | Fixed in Rev 8 | The market list searches every tracked market (`/api/markets` with a JSON filter), category chips from `/api/markets/categories` |
| 8 | Chart: one-point flat line, duplicate y ticks | Minor | Fixed in Rev 8 | `ProbChart` |
| 9 | Wide-book mid shows 42c vs list 5.5c | Major | Fixed in Rev 8 | `displayYes` in `components/terminal/book.ts`: spread > 10c shows the last trade (Polymarket convention); tested |
| 10 | `/trade/autonomy` hits `/trade/[id]` with `id=autonomy` | Minor | Fixed in Rev 8 | Non-hex ids call `notFound()` inside the shell |
| 11 | Double stale banner on `/markets/[id]` | Minor | Moot | `/markets/[id]` redirects to `/trade/[id]` |
| 12 | `/markets` horizontal overflow | Minor | Fixed in Rev 8 | Results scroll inside their panel; `scrollWidth == innerWidth` at 1440/1280/1100 |
| 13 | Terminal disclaimer overlaps the list / clipped at 1280 and 1100 | Minor | Fixed in Rev 8 | Fixed row at the bottom of the list (and the list drawer) |
| 14 | ActionBar key hints glued to labels | Minor | Fixed in Rev 8 | Ghost buttons with spaced key caps |
| 15 | Journal drift panel blank | Minor | Fixed in Rev 8 | Empty state when no resolved thesis has a drift sample |
| 16 | Transient hydration error on `/autonomy` | Minor | Not reproducible | Re-open with a stack if it returns |
| 17 | Dead visitor code: `lib/visitor/tradingKey.ts`, `lib/visitor/autonomy.ts` (+ tests) | Cleanup | Fixed in Rev 8 | Zero non-test importers (grep), deleted with `autonomy.test.ts`; the visitor settings tests moved to `visitor.test.ts`. `toAppSettings` dropped too |
| 18 | `/api/public/*` routes duplicate `/api/markets` | Cleanup | Deferred | Kept as the terminal's read API (`TerminalPage`, `useMarketFeed`; `proxy.ts` keeps it GET/HEAD-only). Merge with `/api/markets` once the terminal is stable |
| 19 | `app/api/pm` relay | Cleanup | Kept | Used: `lib/visitor/relay.ts` -> `wallet.ts` / `exchange.ts` -> `hooks/useWallet.ts` (browser wallet reaches Polymarket through it) |
| 20 | Refresh probe 400 on `/watchlist?tab=alerts` ("Refresh failed" on alert events) | Minor | Fixed in Rev 8 | `components/probe.ts` probes `/api/alerts` for that tab; tested |
| 21 | Chart ALL range: daily buckets give a young market 3 points | Minor | Fixed in Rev 8 | `lib/history.ts` asks again hourly under 30 points; tested |
| 22 | Review: `g r` / `g p` / `g m` on `/trade` also fired research / pin / mute (paid pod) | Major | Fixed in Rev 8 | Page key handlers bail on a key that completes a `g` chord; tested |
| 23 | Review: `g f` toggled the chart axis; non-route chord completions reached page keys | Minor | Fixed in Rev 8 | Same guard in ProbChart; the shell marks every chord completion |
| 24 | Review: fast market clicks briefly showed the previous market | Minor | Fixed in Rev 8 | URL sync adopts only ids it did not write itself |
| 25 | Review: `/api/pm` relay is an anonymous open relay now that login is gone | Minor | Fixed in Rev 8 | Per-IP rate limit (same `kv` limiter as the push routes) |
| 26 | Review: `.env.example` stray auth lines; unused `--t-*` aliases; `BottomTabs` undefined class | Cleanup | Fixed in Rev 8 | Deleted |
| 27 | Drift: chart axis labels under price tags, light-theme halo; ladder hint truncated; settings multi-selects one line tall; Autonomy mode options look disabled; Watchlist `c` column misaligned; search trigger truncated at 1280 | Minor | Fixed in Rev 8 | See commit "fix: review and drift findings" |
| 28 | Chart own fills (up/down triangles, DESIGN 13.4) | Minor | Deferred | `ProbChart` has no fills input yet; own orders are drawn |
| 29 | Screener 24h change column and sparkline (DESIGN 13.5) | Minor | Column fixed, sparkline deferred | `24h` column (default set) from `listMarkets.d24c`; null until a snapshot is 24h old. Sparkline needs a per-row history fetch: deferred |

# Public mode map (L0 scout)

Date: 2026-10-18. Read-only survey of the repo for the public-deploy build. Paths are relative to the repo root. Note: the private key env var is `PM_PRIVATE_KEY` (not `POLY_PRIVATE_KEY`; SPEC.md still says POLY_*).

## 1. Auth boundary

`apps/web/proxy.ts` is the only gate. Its `matcher` (L28-30) covers everything except `_next/static`, `_next/image`, `favicon.ico`.

- Public today: `PUBLIC = new Set(["/login", "/api/login"])` (L4); `PUSH` regex `^/api/(proposals|sets)/[^/]+/push$` (L6, ntfy one-shot tokens checked inside the route, rate limited there); `/.well-known/workflow/*` only when `process.env.VERCEL` (L11).
- Cron-secret gated: any `/api/cron/*` (L16-18) via `checkCron` (`apps/web/lib/auth.ts:59`, `Authorization: Bearer $CRON_SECRET`, fails closed if unset or < 32 bytes). The route re-checks it (`apps/web/app/api/cron/[job]/route.ts:118`).
- Everything else: session cookie `pm_session` OR `Authorization: Bearer <jwt>` (TUI) via `verifySession` (auth.ts:29, HS256, sub must be "owner"; L19-26, L21-24 in proxy). Page requests redirect to `/login?next=`, API requests get 401 JSON.
- Where to add public GET routes: add a branch before the session check at `proxy.ts:11` (extend the early-return condition), e.g. a `PUBLIC_GET` regex/prefix test restricted to `req.method === "GET"` such as `/api/public/`. Recommended: a separate `/api/public/*` prefix and `/` public pages, not un-gating `/api/watchlist` (see 2). Public pages need a route group outside `app/(app)/` (that layout calls `currentMode` and renders the operator shell).
- Rate limiting helper: `Kv.rateLimit(key, limit, windowMs)` in `packages/db/src/kv.ts:48` (Upstash sliding window; memory shim for dev). Only used by `loginRateLimit` (`apps/web/lib/auth.ts:106`). IP from `clientIp(headers)` (auth.ts:99; on Vercel first XFF hop). No generic middleware limiter exists; proxy.ts is async so `getKv().rateLimit("pub:"+ip, ...)` can be called there, but note `getKv()` throws on Vercel without Upstash (kv.ts:118).

## 2. Read API

Handlers are thin; shapes come from `apps/web/lib/jobs/read.ts`. All routes `runtime=nodejs`, `dynamic=force-dynamic`, no caching headers.

- `GET /api/watchlist?tab=small-cap|size|structural&sort=&muted=` (`app/api/watchlist/route.ts`) -> `read.watchlist` (read.ts:48-102). Page equivalent: `app/(app)/watchlist/page.tsx` calls it server-side directly.
- `GET /api/markets/[id]` (`app/api/markets/[id]/route.ts`) -> `read.marketDetail` (read.ts:105-148). Thesis, evidence, agents, snapshot, history, book depth.
- `GET /api/stream` (SSE, `app/api/stream/route.ts`), events from `lib/jobs/events.ts` (in-process EventEmitter, `__pmBus` global).
- Public visitor needs: watchlist + market detail (+ a trimmed stream or just polling).

Fields that must NOT go public:

- watchlist: `pinned`, `muted` (operator flags; `muted` rows are also filtered by `includeMuted` query, so a public route must hardcode muted=false), `sizeUsd`, `shares`, `expectedProfit`, `rank` (all computed from the operator's `bankroll`/`kelly`/`capFrac` settings via `sizeTrade`; a visitor needs their own sizing client-side), `researching` (minor), `thesisId` fine.
- marketDetail: `market.pinned/muted`; `positions` (operator paper book, read.ts:115,146); `pod` + `agents[].usage.costUsd/tokens/durationS` and `agents[].model` (spend leakage); `thesis.podId`; `thesis.sizeUsd/shares/expectedProfit/capped/judgeConfidence/trigger/model` (sizing derived from operator bankroll, internal). `evidence` (url/quote/claim) is the intended public content. `snapshot` fine.
- SSE: payloads carry `proposal.*`, `order.*`, `recon.*`, `set.*`, `mode.changed`, `paper.fill` (events.ts publishers in jobs/live.ts, sync.ts, sets.ts, autonomy.ts, paper.ts). Do not expose `/api/stream` as is. A public stream would need an allowlist of `sweep.done`, `snapshot.done`, `screen.done`, `thesis.created`, `pod.done` and stripped payloads (`thesis.created` has `sizeUsd`). Note the bus is in-memory: on Vercel, events published in a cron function instance never reach a viewer's SSE instance, so SSE is effectively broken on serverless anyway (events.ts:5 says so). Public mode should poll.
- Operator-only routes (all stay gated): `/api/settings`, `/api/autonomy*`, `/api/proposals*`, `/api/sets*`, `/api/book/live`, `/api/paper*`, `/api/fleet`, `/api/recon/rebaseline`, `/api/markets/[id]/research` (POST; spends Anthropic money), `/api/markets/[id]/flags`. `/api/calibration` is aggregate and could be public but includes per-model stats; judgment call.

## 3. Pages and components

App routes: `/` (redirect to `/watchlist`, `app/page.tsx`), `/login`, and under group `(app)`: `/watchlist`, `/markets/[id]`, `/fleet`, `/calibration`, `/paper` (Book), `/autonomy`, `/settings`. Root layout `app/layout.tsx` (theme script only, `<title>PM-EDGE</title>`).

- Shell: `app/(app)/layout.tsx` (server; reads `currentMode` + last snapshot ts) -> `components/Shell.tsx`. NAV (Shell.tsx:69) lists all six operator pages; header shows `ModeBadge` (global autonomy mode), `ApprovalsBadge`, `KillSwitchButton`, SSE indicator; it fetches `/api/autonomy` on mount (Shell.tsx:100) and `/api` + pathname for refresh probes (Shell.tsx:88). A public shell must be a separate layout (strip nav, mode, kill, approvals, autonomy fetch).
- Watchlist: `app/(app)/watchlist/page.tsx` -> `WatchlistView.tsx` (tabs small-cap/size/structural; takes `small`, `size`, `structural` rows). Uses `FlaggedSetBar`, `EdgeBadge`, `DataTable`, `Sparkline` etc.
- Market detail: `app/(app)/markets/[id]/page.tsx`: `MarketHeader`, `ActionBar` (pin/mute/research buttons, operator only), `PriceHistoryChart`, `DepthChart`, `EvidenceTable`, `ThesisPane`, `KillCriteriaList`, `CatalystList`, `AgentEstimates` (shows models/costs; operator only), `StaleBanner`. Reusable for public: all but `ActionBar` and `AgentEstimates`. The page itself calls `read.marketDetail` server-side, so it also needs a public-safe projection.
- Login flow: `app/login/page.tsx` -> `LoginForm` -> `POST /api/login` (`app/api/login/route.ts`): `loginRateLimit` 5/15min/IP, argon2 verify of `APP_PASSWORD_HASH`, `signSession` JWT, httpOnly SameSite=Strict cookie `pm_session` (7d). TUI gets the token in the body (`x-client: tui`). `POST /api/logout` clears it.

## 4. packages/core browser safety

Verdict: browser-safe. `packages/core` depends only on `zod` (package.json), and grep for `node:`, `fs`, `path`, `crypto`, `Buffer`, `process.` across `src/` (non-test) finds nothing. All pure functions (the `createHash` node import lives in `packages/agents/src/runner.ts:1`, not core). Barrel is `src/index.ts` (ESM, TS source, `transpilePackages` in Next).

Signatures:

- `sizeTrade(a: SizeInput): WatchCore | null` (`src/sizing.ts:79`). `SizeInput = { bids: Level[]; asks: Level[]; pMid; pHat; c; daysLeft; feeRate; crowdC; crowdSide: Side | null; settings: Settings }` (sizing.ts:5-16). Throws on out-of-range pHat/pMid/c/crowdC.
- `checkOrder(o: Order, x: Exposure, l: Limits): { ok; violations: Violation[] }` (`src/book/risk.ts:33`). `Order = { sizeUsd; marketId; eventId; category }`, `Exposure = { bankroll; byMarket; byEvent; byCategory; totalOpen; dailyNotional; dailyRealizedLoss }`, `Limits = { perTradeUsd; perTradePct; perMarket; perEvent; perCategory; totalOpen; dailyNotional; dailyLoss }`.
- `checkSet(legs: SetLeg[], event: {eventId; category}, x: Exposure, l: Limits)` (`src/book/sets.ts:10`).
- `autoAllowed(o: {sizeUsd; category; isSet?}, l3: L3Limits, autoSentToday: number): {ok; reason?}` (sets.ts:29). `L3Limits = { perTradeUsd; dailyNotional; categoryAllowlist: string[]; structuralAuto: boolean }`.
- `livelimitPrice({vwap, pPost, tick}): number | null` (`src/book/live.ts:10`); also `gtdExpiry(thesisExpiresAt: Date|null, now: Date): Date|null` (live.ts:18, min 3 min), `proposalExpiry` (live.ts:4), `reconcile`.
- Fees: `takerFeePerShare(feeRate, p): number` (`src/fees.ts:2`), `feeRateFor(category, marketRate): {rate; fallback}` (fees.ts:18), `FALLBACK_FEE_RATES`.
- Also relevant: `effectiveMode`, `requestModeChange`, `autoDowngrade`, `qualifies`, `canStartPod`, `setLegPlan`, `exitDecision`, `gateStats`.
- Settings: core exports `Settings` type and `DEFAULT_SETTINGS` (`src/types.ts:103`; sizing knobs: slippageCents, cCoef, crowdBonus, tDecayDays, bankroll, kelly, capFrac, minEdge, rAnnCap, filters, sizeTargets). The wider `AppSettings` (budget, models, limits incl. `l3`, overrides), its zod schema and `DEFAULT_APP_SETTINGS` live in `apps/web/lib/jobs/settings.ts:9-48`, NOT core, and that file imports `@pm/db` (drizzle) at the top, so it is not importable from client code. A browser loop must either move `Limits`/`L3Limits` defaults into core or redefine them client-side.
- DB-to-core mappers (`toMarket`, `toSnap`, `feeOf`) are in `apps/web/lib/jobs/deps.ts:88-105` and pull `@pm/db`/`@pm/agents`/`@pm/pm` imports; not reusable in the browser as is.

## 5. packages/pm exchange

- `clobExchange(env = process.env)` (`packages/pm/src/exchange.ts:72`): parses `PM_PRIVATE_KEY` (+ `PM_SIGNATURE_TYPE` eoa|deposit, default deposit) with zod, builds signer with `privateKeyToAccount(pk)` (viem/accounts) and `privateKey(pk)` from `@polymarket/client/viem` (L86-87), lazily `createSecureClient({ signer, wallet: mode==="eoa" ? signerAddress : undefined })` (L87). Derives CLOB API creds inside `createSecureClient`. Per-instance token bucket `bucket(500, 10_000)`. Errors scrubbed of key/creds.
- `exchangeFromEnv` (L196): null when `PM_FIXTURES=1` or no `PM_PRIVATE_KEY`.
- Browser feasibility: `@polymarket/client@0.13.0` dist JS has no `node:` imports, `process.env` or `Buffer` (grepped `dist/*.js`); `sideEffects: false`; exports `./viem` (signerFrom/privateKey), `./actions`, `./node`, `./privy`, `./ethers-v5`. Per `docs/research/public-deploy.md` Q2, `signerFrom(walletClient)` takes a viem WalletClient, so the same `createSecureClient`/`placeLimitOrder`/`placeMarketOrder`/`cancelOrders`/`listOpenOrders`/`listAccountTrades`/`fetchBalanceAllowance` calls should work with a wagmi WalletClient. NOT verified in a browser; CORS on `clob.polymarket.com` unknown; package declares `engines.node >= 24`. `clobExchange` itself is not reusable as is: it hardwires env + private key; a browser variant would take a `Signer` and reuse the same `call` wrapper, `validateOrder`, `scrub`. Also `exchange.ts` imports only type-level `SecureClient`, viem, zod, `./bucket` (all browser-safe), and `packages/pm/src/index.ts` (`createPm`) reads `process.env.PM_FIXTURES` and uses `fetch` (fine in browser except for that env read).
- Geoblock: project memory says Ireland is geoblocked from Polymarket; dub1 region and an Irish operator matter for ToS (see docs/research/public-deploy.md).
- `Exchange` seam (exchange.ts:15-25): `address(): string`; `place(o: LimitOrder): Promise<Placed>` (GTD limit); `placeImmediate(o: ImmediateOrder): Promise<ImmediateResult>` (FOK/FAK, throws on unknown outcome); `cancel(orderIds: string[])`; `cancelAll()`; `openOrders(): Promise<OpenOrder[]>`; `trades(since: Date): Promise<ExchangeTrade[]>`; `balance(): Promise<{usdc}>`; `positions(): Promise<Record<tokenId, shares>>`. `fakeExchange(opts)` (L212) adds `fill`, `setBalance`, `failNext`, `scriptImmediate`. `clobExchange` additionally has `wallet()`.
- Order types: `LimitOrder = {tokenId; side; price; shares; expiresAt: Date}`, `ImmediateOrder = {tokenId; side; shares; capPrice; type: "FOK"|"FAK"}`.

## 6. packages/agents

- Selection: `pickRunner(env)` in `packages/agents/src/runner.ts:57`. No `ANTHROPIC_API_KEY` -> `fake` (deterministic hash-derived probabilities, example.com URLs, zero cost). Key + Vercel creds (`VERCEL_OIDC_TOKEN` or `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`, runner.ts:54) -> `sandbox` (`sandbox.ts`, one `@vercel/sandbox` node:24 per agent, `npm install` of the Agent SDK each time, 120 s extra timeout, only `ANTHROPIC_API_KEY`+`EXA_API_KEY` enter the sandbox). Key only -> `local` (`local.ts`, in-process Agent SDK query). Wired in `apps/web/lib/jobs/deps.ts:56`; judge: `anthropicJudge(client)` if key else `fakeJudge` (deps.ts:57); `rScore` LLM classifier only with key (deps.ts:58).
- RISK: in production with `ANTHROPIC_API_KEY` unset the app silently runs fake agents + fake judge and writes fabricated theses (random p_hat, example.com evidence) into the DB that the public watchlist would display. There is no prod guard or warning. Worth failing closed or labelling for public mode.
- Exa: only in `packages/agents/src/agent-query.mjs:12-35`. A local in-process MCP server ("exa") exposes tools `search` and `contents` calling `https://api.exa.ai` with `x-api-key: input.exaKey || process.env.EXA_API_KEY`; built-in tools (Bash/WebFetch/WebSearch etc.) disallowed (L161-163); cap `exaCallCap` per agent (default `budget.exaCallsPerPod` = 10). If `EXA_API_KEY` unset on a real runner: header becomes the string "undefined"/empty, Exa returns HTTP 401, tool returns `isError` "Exa HTTP 401", agent runs without search (no hard failure, poor evidence). Local runner passes `env.EXA_API_KEY ?? ""`; sandbox passes `""`.
- Pod trigger: `researchMarket(d, conditionId, trigger)` (`apps/web/lib/jobs/research.ts:31`): kv lock per market (30 min), budget check, pod row, `runPod`, judge, `sizeTrade`, inserts `agentRuns`/`evidence`/`theses`. Triggers: cron `research` -> `researchShortlist(d)` (research.ts:141; shortlist + stale re-research; triggers "initial"/"price-move"/"catalyst"/"stale"); manual: `POST /api/markets/[id]/research` (`app/api/markets/[id]/research/route.ts`, 202 + `after()`, session-gated). On Vercel the `research` cron goes through Vercel Workflow (`apps/web/workflows/jobs.ts`, started in `cron/[job]/route.ts:125`) unless `WORKFLOW_INLINE=1`.
- Budget knobs (settings `budget`, defaults in `apps/web/lib/jobs/settings.ts:40`): `maxPodsPerDay` 40, `maxConcurrentSandboxes` 5, `sandboxTimeoutMin` 10, `exaCallsPerPod` 10, `dailySpendCapUsd` 50. Enforced in `researchMarket` research.ts:38-57 via `canStartPod` (`packages/core/src/book/budget.ts:13`; order: DAILY_SPEND_CAP first, then MAX_PODS_PER_DAY, then MAX_CONCURRENT_SANDBOXES) under kv lock `research-budget`. Spend is accumulated in `spend` table by `addSpend` (research.ts:26). The cap is checked only at pod start (a pod can overshoot by one pod cost), and the cap is on Anthropic USD only, not Exa or sandbox seconds. `sandboxTimeoutMin`/`exaCallsPerPod` enforced inside the runner (timeoutMs, exaCallCap).

## 7. DB and Redis

- DB: `packages/db/src/client.ts:22` `getDb()`: `DATABASE_URL` set -> Neon serverless HTTP driver (`drizzle-orm/neon-http`; HTTP driver has no multi-statement transactions); unset -> PGlite at `<repo>/.data/pglite` (`PGLITE_DIR` overrides; `memory://` for tests; `mkdirSync` of parent).
- Migrations: `bun run --cwd packages/db db:migrate` (`tsx src/migrate.ts` -> `migrate()` from client.ts; folder `packages/db/drizzle`). Generate: `db:generate`. At runtime, `dbReady()` (`apps/web/lib/jobs/deps.ts:42`) auto-migrates ONLY on PGlite; with `DATABASE_URL` it does not migrate ("Neon is migrated at deploy"). No build/deploy hook runs it: `turbo.json` build and `vercel.json` have no migrate step and no GitHub workflows exist, so migrations on Neon are a manual step (must run `db:migrate` with `DATABASE_URL` before first deploy and on every schema change).
- Redis: `packages/db/src/kv.ts:114` `getKv()`: `UPSTASH_REDIS_REST_URL`+`_TOKEN` -> Upstash (`lock` SET NX PX with owner-checked Lua release, `rateLimit` sliding window, `get/set`); else memory shim. In `NODE_ENV=production` on `VERCEL` without Upstash it THROWS (kv.ts:118), so login and every locked job fail without Upstash. Non-Vercel production warns and uses memory.
- Vercel breakage points: (a) PGlite file path writes to repo dir; read-only/ephemeral on Vercel and `@electric-sql/pglite` is in `serverExternalPackages`, so a missing `DATABASE_URL` on Vercel means an empty ephemeral DB per instance (silent). (b) memory kv is per instance (handled by the throw). (c) SSE bus is in-process (events.ts), so cross-instance events are lost, and `/api/stream` holds up to 300 s functions. (d) `PM_FIXTURES=1` must be unset in prod (it shifts `defaultNow` to a fixed 2026-10-15 clock, deps.ts:28, and `createPm` serves fixtures, `packages/pm/src/index.ts:33`). (e) `@node-rs/argon2` native dep in login route (external, ok on Vercel linux x64). (f) Neon HTTP: no transactions, so multi-statement atomicity relies on the kv lock only.

## 8. Vercel config and next.config

`apps/web/vercel.json`: `regions: ["dub1"]`. No `functions` block (per-route `maxDuration` is set in code: cron route and stream and research route = 300). Crons (all hit `/api/cron/[job]`, GET with CRON_SECRET bearer that Vercel injects only if the env var `CRON_SECRET` is set):

- `/api/cron/sweep` `0,30 * * * *`
- `/api/cron/snapshot` `*/5 * * * *`
- `/api/cron/snapshot?scope=all` `5,35 * * * *` (long -> Workflow on Vercel)
- `/api/cron/screen` `10,40 * * * *`
- `/api/cron/research` `20 * * * *` (long -> Workflow)
- `/api/cron/paper` `*/15 * * * *`
- `/api/cron/propose` `1-59/5 * * * *`
- `/api/cron/sets` `2-59/5 * * * *`
- `/api/cron/expire` `*/2 * * * *`
- `/api/cron/sync` `*/2 * * * *`
- `/api/cron/reconcile` `3-59/5 * * * *`
- `/api/cron/calibrate` `0 3 * * *`

12 cron entries, several every 2 to 5 minutes: requires a Vercel plan allowing sub-daily crons (Pro). `propose`, `sets`, `expire`, `sync`, `reconcile`, `paper` are operator-trading jobs; a public single-tenant scouting deploy only needs sweep, snapshot, screen, research, calibrate.

`apps/web/next.config.ts`: `transpilePackages: ["@pm/core","@pm/pm","@pm/agents","@pm/db"]`, `serverExternalPackages: ["@electric-sql/pglite","@node-rs/argon2"]`, wrapped in `withWorkflow` (`workflow/next`, Vercel Workflow 5.2.2). Next 16.4.1, React 19.3.1; no wagmi/viem in `apps/web` deps yet (viem is in packages/pm). Root `turbo.json` `globalPassThroughEnv` lists the env names that reach the build.

## 9. Env vars (grep of process.env, non-test)

Required for prod marked R.

- `JWT_SECRET` R (>= 32 bytes): `apps/web/lib/auth.ts:14`, `apps/web/app/api/login/route.ts:24`
- `APP_PASSWORD_HASH` R (argon2id PHC, `\$` escape in .env): `apps/web/lib/auth.ts:90`
- `CRON_SECRET` R (>= 32 bytes): `apps/web/lib/auth.ts:59`
- `DATABASE_URL` R (Neon): `packages/db/src/client.ts:24`; `apps/web/lib/jobs/deps.ts:43`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` R on Vercel: `packages/db/src/kv.ts:115,118` (plus `Redis.fromEnv()`)
- `ANTHROPIC_API_KEY` R for real research (else fake agents): `apps/web/lib/jobs/deps.ts:48`; `packages/agents/src/runner.ts:58`; `packages/agents/src/agent-query.mjs:167`; sandbox passes it `sandbox.ts:96`
- `EXA_API_KEY` recommended: `packages/agents/src/agent-query.mjs:15,167`; `local.ts:8`; `sandbox.ts:96`
- `VERCEL_OIDC_TOKEN` | `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID` (sandbox runner, read through `env` param): `packages/agents/src/runner.ts:54`, `sandbox.ts:83-84`. OIDC token is auto-provided on Vercel.
- `PM_FIXTURES` must be unset in prod: `apps/web/lib/jobs/deps.ts:28`; `packages/pm/src/index.ts:33`; `packages/pm/src/exchange.ts:197`; `apps/web/scripts/seed.ts:2`
- `PM_PRIVATE_KEY` operator only, optional: `packages/pm/src/exchange.ts:73,197`; `packages/pm/scripts/clob-smoke.ts`. `PM_SIGNATURE_TYPE` optional: `exchange.ts:73`.
- `NTFY_TOPIC`, `NTFY_URL`, `NTFY_TOKEN`, `APP_URL` optional (ntfy approvals; read via the `env` param in `apps/web/lib/jobs/live.ts:244-264` and `sets.ts:159`; not matched by the literal `process.env.` grep because accessed as `env.X`; names from `.env.example`)
- `VERCEL` (platform, set automatically): `apps/web/proxy.ts:11`, `apps/web/lib/auth.ts:101`, `apps/web/app/api/cron/[job]/route.ts:125`
- `WORKFLOW_INLINE` optional (`=1` runs long jobs inline): `apps/web/app/api/cron/[job]/route.ts:125`
- `NODE_ENV` (platform): `apps/web/lib/auth.ts:44` (cookie secure), `packages/db/src/kv.ts:118,121`
- `PGLITE_DIR` dev only: `packages/db/src/client.ts:30`
- `PM_API_BASE` TUI only: `apps/tui/src/api.ts:5`, `apps/tui/src/auth.ts:33`, `apps/tui/src/cli.tsx:16`
- Missing from `turbo.json` globalPassThroughEnv: `PM_PRIVATE_KEY`, `PM_SIGNATURE_TYPE`, `NTFY_*`, `APP_URL`, `VERCEL_*`, `WORKFLOW_INLINE` (matters only for build-time; runtime reads Vercel env directly).

## Surprises and risks

1. Fake agents and judge silently used when `ANTHROPIC_API_KEY` is unset, in any environment, with no flag on the stored theses.
2. `/api/watchlist` and `/api/markets/[id]` are cheap to un-gate but leak operator-derived sizing, flags, paper positions, spend/usage; need a projection layer.
3. In-memory SSE bus does not work across Vercel instances; public mode should poll.
4. No automated Neon migration; `dbReady` skips migration when `DATABASE_URL` is set.
5. Shell/layout of `(app)` is operator-bound (global mode, kill switch, autonomy fetch); public pages need a separate route group.
6. `AppSettings`/limits live in `apps/web` and import drizzle; the browser loop needs `Limits`/`L3Limits` types and defaults moved to `packages/core`.
7. `@polymarket/client` browser runtime and clob CORS are unverified; Ireland geoblock per project memory.
8. Daily spend cap is checked only at pod start; a public "run research on this market" button must stay out (the manual research route spends real money).

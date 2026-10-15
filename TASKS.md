# TASKS — Polymarket Edge Engine (build 1: phases 1–5)

Harness: Claude Code · Planner: claude-opus-5-5 · Stack mode: native (Codex is ChatGPT-authed, luna only)

## Roles

| Role | Model @ effort |
|---|---|
| planner | opus-5-5 |
| heavy (L3) | opus @ medium |
| worker (L2) | sonnet @ medium |
| grunt (L1) | haiku @ max |
| designer, ui-impl | fable @ medium |
| reviewer | same class, other family than implementer |
| scout, research (L0) | haiku @ high |
| drift-check | haiku @ low |

## Destination

Phases 1–5 of SPEC.md: screener + structural detectors, research pods + judge + sizing, web + TUI, calibration, paper book (L0/L1) with autonomy controller and risk-limit engine. Execution (L2+) refused server-side until phase 6.

## Build decisions (binding for every agent)

1. Scope = phases 1–5. Modes L2/L3/L4 exist in types and Settings, but the autonomy controller refuses to enter them (`EXECUTION_DISABLED` reason, logged to `autonomy_events`). No `@polymarket/clob-client`, no wallet key handling in this build.
2. Stack per SPEC: pnpm workspaces + Turborepo, TypeScript, Next.js App Router, Ink, Drizzle, zod, vitest.
3. Offline-verifiable. This machine cannot reach Polymarket (ISP block) and has no credentials.
   - DB: `DATABASE_URL` set → Neon (`@neondatabase/serverless` + drizzle). Unset → PGlite (`@electric-sql/pglite`, file at `.data/pglite`) with the same Drizzle schema.
   - Redis: Upstash env set → `@upstash/redis`. Unset → in-memory shim with the same small interface (lock, rate-limit bucket).
   - Polymarket: `PM_FIXTURES=1` (default when unreachable / in tests) → clients read recorded JSON fixtures from `packages/pm/fixtures`.
   - Anthropic/Exa: keys unset → research pods use a deterministic fake runner (test + local demo). Real path coded against the documented SDKs.
   - Vercel Workflow/Sandbox: step logic in plain async functions (`packages/agents`, `apps/web/lib/jobs`); Workflow/Sandbox adapters thin. Locally a step runner calls the same functions in-process.
4. Done = `pnpm install && pnpm turbo typecheck test build` green, `pnpm dev` serves the web app with a populated watchlist from fixtures, `pnpm --filter tui start` renders the watchlist against the local API.
5. Model ids in code: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (router defaults per SPEC).

## Tasks

| id | task | level / role | deps | status |
|---|---|---|---|---|
| R1 | Research Polymarket Gamma/CLOB/Data API shapes, fees, neg-risk → `docs/research/polymarket.md` | L0 research haiku@high | — | todo |
| R2 | Research Claude Agent SDK query()+structured output+MCP, Vercel Sandbox, Vercel Workflow, Exa API, PGlite+drizzle → `docs/research/runtime.md` | L0 research haiku@high | — | todo |
| D1 | DESIGN.md: web + TUI brief | L2 designer fable@medium | — | todo |
| T0 | Monorepo scaffold | L1 grunt haiku@max | — | todo |
| T1 | packages/core: screening, sizing, fees, structural detectors | L2 worker sonnet@medium | T0 | todo |
| T2 | packages/core: calibration, autonomy/risk-limit engine, paper fills | L2 worker | T0 | todo |
| T3 | packages/db schema + client (Neon/PGlite) | L2 worker | T0 | todo |
| T4 | packages/pm clients + token buckets + fixtures | L2 worker | T0, R1 | todo |
| T5 | packages/agents: router, runner (Sandbox + fake), pod, judge, Exa MCP | L2 worker | T0, R2, T1 | todo |
| T6 | Auth: login, jose JWT, middleware, rate limit, TUI bearer | L3 heavy (auth) | T0, T3 | todo |
| T7 | Web API + jobs (sweep, snapshots, screen, pods, calibration, paper) + crons + SSE | L2 worker | T1–T5 | todo |
| T8 | Web UI per DESIGN.md | L2 ui-impl fable@medium | D1, T7 | todo |
| T9 | Ink TUI per DESIGN.md | L2 ui-impl fable@medium | D1, T7 | todo |
| V | Verification gate | reviewers | all | todo |

## Decisions so far

- 2026-10-15: T1 done (89995e7). `@pm/core`: fees, screen (pass1, factorI/L/T, crowd, priority, screen), sizeTrade → WatchCore|null (both sides, best e), negRiskArb, ladderViolations, mirrorPairs, AgentOutput, capConfidence, DEFAULT_SETTINGS (B=1000 placeholder). I excludes sibling drift (no input yet).
- 2026-10-15: T5 done (607061d). `@pm/agents`: modelFor, buildBrief (no price), classifyR+rulesHash, AgentRunner, fakeRunner, pickRunner(env), withBackoff, AnthropicOutageError, anthropicJudge/fakeJudge, runPod → {agents, judge{capped}, evidence, costs}, PodFailedError (<3 ok). Exa via fetch. OPEN for verification: base-rate agent has no script tool (SPEC says it runs small scripts) — allow Bash inside sandbox runner only.
- 2026-10-15: T7 split → T7a jobs/read models/seed (dispatched sonnet@medium), T7b API routes + SSE + crons + Workflow (after T7a).
- 2026-10-15: T4 done. `@pm/pm` createPm({fixtures}) → listMarkets/listEvents/market/comments/books/midpoints/spreads/lastTradePrices/pricesHistory/feeRateBps/tickSize/holders/oi/trades. Normalized snake_case types (Market, PmEvent, Book…) — T7 maps to core camelCase. feeRate = feeRateBps/10000 (unit UNVERIFIED). Fixtures: neg-risk arb a1–a4 (buy-all), c1–c3 (sell-all), ladder l2>l3, mirror m1/m2, longshots s*, illiquid i*, dispute d1.
- 2026-10-15: T6 done (0bf0820). /api/login, /api/logout, proxy.ts (cookie or bearer; /api/cron/* needs CRON_SECRET), lib/auth helpers, TUI `pm login` + token 0600. Review item: XFF first hop trusted (safe on Vercel only).
- 2026-10-15: T5 dispatched (sonnet@medium). T6 dispatched (opus@medium, L3 auth).
- 2026-10-15: T3 done (bc1d387). `@pm/db`: getDb() (Neon http / PGlite), migrate(), schema, latestSnapshot, insertSnapshots, getKv() {lock, rateLimit, get, set}. TS 6 pinned in packages/db for drizzle-kit. Extra tables: settings, market_flags, spend, rr_cache.
- 2026-10-15: T2 done (16b975b). `@pm/core` book/: calibration, autonomy (raises to ≥L2 refused EXECUTION_DISABLED; lowering always allowed), autoDowngrade(signals, current), qualifies, checkOrder, paperFill(asks, sizeUsd, feeRate), applyFill, settle, realizedEdge, shouldReResearch, canStartPod. c mapping 0.4 + 0.5·clamp(skill/0.05) — tune with data.
- 2026-10-15: R2 done → docs/research/runtime.md (versions table there is authoritative). Next 16: auth guard lives in `proxy.ts` (Node runtime). Anthropic structured output via `output_config.format`, never forced `tool_choice`. Agent SDK: `outputFormat` + `result.structured_output`, cost from last result message. Workflow errors: `FatalError` / `RetryableError`. Password hashing `@node-rs/argon2`.
- 2026-10-15: R1 done → docs/research/polymarket.md. Raw fetch for Gamma/CLOB/Data (no SDK dependency for reads). Lenient zod parsing (coerce numeric strings, passthrough). Fee rate read at runtime from CLOB `/fee-rate`, category table only as fallback. Add `record-fixtures` script for capture from an unblocked network. Phase-6 note: `@polymarket/clob-client` archived, SPEC execution stack must be revisited.
- 2026-10-15: D1 done → DESIGN.md. Watchlist API row includes `c` and `side`. Settings "weights" = SPEC constants only (C coef 0.5, crowd bonus 0.2, T decay 60 d, size targets). Fonts: system stacks (`ui-monospace`, `system-ui`), no font loading.
- 2026-10-15: scope phases 1–5 (user). Offline verification via PGlite / memory Redis / fixtures / fake runner (planner).
- 2026-10-15: T0 done (1b9edbd). Kept hand-built scaffold (no generators). TypeScript 7.0.2 = native port, no JS API: if a tool needs it, pin `typescript@6` in that package only. Turbo strict env: declare env vars in turbo.json when used.

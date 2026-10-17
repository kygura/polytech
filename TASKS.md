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
2. Stack per SPEC: bun workspaces + Turborepo (pnpm until 2026-10-17), TypeScript, Next.js App Router, Ink, Drizzle, zod, vitest.
3. Offline-verifiable. This machine cannot reach Polymarket (ISP block) and has no credentials.
   - DB: `DATABASE_URL` set → Neon (`@neondatabase/serverless` + drizzle). Unset → PGlite (`@electric-sql/pglite`, file at `.data/pglite`) with the same Drizzle schema.
   - Redis: Upstash env set → `@upstash/redis`. Unset → in-memory shim with the same small interface (lock, rate-limit bucket).
   - Polymarket: `PM_FIXTURES=1` (default when unreachable / in tests) → clients read recorded JSON fixtures from `packages/pm/fixtures`.
   - Anthropic/Exa: keys unset → research pods use a deterministic fake runner (test + local demo). Real path coded against the documented SDKs.
   - Vercel Workflow/Sandbox: step logic in plain async functions (`packages/agents`, `apps/web/lib/jobs`); Workflow/Sandbox adapters thin. Locally a step runner calls the same functions in-process.
4. Done = `bun install && bunx turbo typecheck test build` green, `bun run dev` serves the web app with a populated watchlist from fixtures, `bun --filter tui start` renders the watchlist against the local API.
5. Model ids in code: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (router defaults per SPEC).

## Tasks

| id | task | level / role | deps | status |
|---|---|---|---|---|
| R1 | Research Polymarket Gamma/CLOB/Data API shapes, fees, neg-risk → `docs/research/polymarket.md` | L0 research haiku@high | — | done |
| R2 | Research Claude Agent SDK query()+structured output+MCP, Vercel Sandbox, Vercel Workflow, Exa API, PGlite+drizzle → `docs/research/runtime.md` | L0 research haiku@high | — | done |
| D1 | DESIGN.md: web + TUI brief | L2 designer fable@medium | — | done |
| T0 | Monorepo scaffold | L1 grunt haiku@max | — | done |
| T1 | packages/core: screening, sizing, fees, structural detectors | L2 worker sonnet@medium | T0 | done |
| T2 | packages/core: calibration, autonomy/risk-limit engine, paper fills | L2 worker | T0 | done |
| T3 | packages/db schema + client (Neon/PGlite) | L2 worker | T0 | done |
| T4 | packages/pm clients + token buckets + fixtures | L2 worker | T0, R1 | done |
| T5 | packages/agents: router, runner (Sandbox + fake), pod, judge, Exa MCP | L2 worker | T0, R2, T1 | done |
| T6 | Auth: login, jose JWT, middleware, rate limit, TUI bearer | L3 heavy (auth) | T0, T3 | done |
| T7 | Web API + jobs (sweep, snapshots, screen, pods, calibration, paper) + crons + SSE | L2 worker | T1–T5 | done |
| T8 | Web UI per DESIGN.md | L2 ui-impl fable@medium | D1, T7 | done |
| T9 | Ink TUI per DESIGN.md | L2 ui-impl fable@medium | D1, T7 | done |
| V | Verification gate | reviewers | all | done |

## Decisions so far

- 2026-10-16: T8b done (d6bb743). Fleet row expands in place, output in Drawer. Gaps deferred: settings excluded-tags (no schema field), fleet retry badge (no data), category override → inherit (PUT merges, no key delete). 200/200 tests. Gate V dispatched.
- 2026-10-16: gate V loop 1. Reviews in (risk opus, reliability/resilience/readability/spec sonnet, drift haiku). Fix batches dispatched, disjoint files, no agent commits: A1 research/runtime (sonnet), A2 screen/sweep/paper/read/autonomy money paths (sonnet), B auth hardening (sonnet), C UI/TUI drift (fable). Deferred → phase 6+ notes: comment skew in C, NEW_HIT re-research trigger, cross-instance SSE bus, logout token revocation, /m/[conditionId] route (docs/api.md uses /markets/[id]). Readability cleanup = recommendations only.
- 2026-10-16: gate V PASSED (025eed4..3640273). Loop 3: no-candidate stale threshold 15 min; sweep shrink honored after 3 consecutive truncated listings. Final smoke at 3640273 in clean worktree: install clean, 13/13 turbo tasks, 228 tests, authed web checks, L2 refused, kill/re-arm, cron auth, workflow route guarded off Vercel, TUI login + watchlist render. Open (low): /markets/<bad id> returns 200 not 404; TUI first frame shows offline before SSE connects; core checkOrder still flags dailyLoss=0 as violation (L1 records only).
- 2026-10-16: gate V loop 2. Re-review (opus) found: base_rate Bash in sandbox can leak API keys via prompt injection → Bash reverted for all roles (SPEC divergence; needs key isolation + egress allowlist, phase 6). Also sandbox outage detection, global stale measure, self-hosted clientIp order, sweep floor vs previous listing, reaper waves, early-close edge, dailyLoss=0, kv cap, TUI bearer http guard. pnpm-workspace allowBuilds += @swc/core, cbor-extract. TUI test flake = fixed 60ms wait (now polls); header keeps mode + K visible when narrow.
- 2026-10-15: T1 done (89995e7). `@pm/core`: fees, screen (pass1, factorI/L/T, crowd, priority, screen), sizeTrade → WatchCore|null (both sides, best e), negRiskArb, ladderViolations, mirrorPairs, AgentOutput, capConfidence, DEFAULT_SETTINGS (B=1000 placeholder). I excludes sibling drift (no input yet).
- 2026-10-15: login fix (c82c1f5). Root cause: Next dotenv-expand mangles `$` in APP_PASSWORD_HASH (97 → 44 chars). Fix: hash-password emits `\$`-escaped value, passwordHash() unescapes + validates prefix, misconfig → 500 + log. Gate: live login with smoke password from .env.local.
- 2026-10-15: T8a done (8c3531e). Shell, components, /login, /watchlist, /markets/[id]. Bug found: login 401 under `next start` (argon2 error swallowed) → sent to T6 agent for diagnosis. T8b dispatched (fable@medium).
- 2026-10-15: T9 done (8676001). Ink TUI, 6 views + settings, no new deps, hand-rolled SSE parser. Untested against live API → gate must smoke `pm` against `next start`.
- 2026-10-15: proxy fix (1e73b89): /.well-known/workflow/* bypasses session guard. Auth for those routes relies on Vercel platform-side queue signing (docs-only evidence); unauthenticated if self-hosted. Review item for review-risk.
- 2026-10-15: T7b done (f0ccebd). All docs/api.md routes; cron = app/api/cron/[job]; Workflow real (withWorkflow, start() on Vercel for long jobs, inline otherwise). Region via vercel.json (preferredRegion deprecated). Follow-ups: proxy must pass /.well-known/workflow/* (sent to T6 agent); clean install may need `pnpm approve-builds` for @swc/core, cbor-extract (check at gate). Paper close = best bid, no depth walk/fee.
- 2026-10-15: T7a done (9be5660). lib/jobs: jobs + read.* + seed (26 watch rows, 11 structural, 8 theses, 5 paper fills). Additive migration 0001. Paper fills proceed with risk violations recorded (L1 = observe violations). Not done: Exa call counting, category-scoped setMode, L3 limits enforcement (phase 7).
- 2026-10-15: docs/api.md contract fixed. Server components call read.* directly; client components + TUI via HTTP. T8 split → T8a (shell, components, watchlist, detail, login) then T8b (fleet, calibration, paper, autonomy, settings). Dispatched T7b (sonnet), T8a (fable), T9 (fable) in parallel.
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

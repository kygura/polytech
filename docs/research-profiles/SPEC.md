# Research Profiles — Spec

## What it does

Lets the operator steer, filter and launch agent research from the web dashboard instead of relying on the hardcoded pod and screener shortlist.

Two entry points, one engine (`runPod`):

1. **Research profiles** — saved, named configurations of *which markets* (filter) and *how to research them* (steering), with an optional schedule. Enabled profiles run automatically from the existing `research` cron job.
2. **Ad-hoc runs** — launch research on any single market from its page, starting from a profile (or the built-in default) and overriding any steering field for that run.

The existing screener shortlist keeps running unchanged as the implicit "screener" path. Profiles add to it; all paths share the existing daily budget (`canStartPod`).

## Data model

New table `research_profiles` (drizzle, new migration `0007_*`):

| column | type | notes |
|---|---|---|
| id | text pk | |
| name | text unique | |
| enabled | bool | scheduled runs only when true |
| filter | jsonb | `ProfileFilter` |
| steering | jsonb | `Steering` |
| every_min | int null | schedule interval; null = manual only |
| last_run_at | timestamptz null | |
| created_at / updated_at | timestamptz | |

`pods` gains `profile_id text null` and `steering jsonb null` (the exact resolved steering that ran, for audit in Fleet).

### ProfileFilter (all optional, AND-combined, active markets only)

- `categories: string[]`, `tagsAny: string[]`, `textQuery: string` (case-insensitive match on question)
- `minVol24h`, `minDepthUsd` (snapshot `depth_5c_usd`), `maxSpread` (latest snapshot `best_ask - best_bid`)
- `endsWithinDays: {min?, max?}` (from `end_date`)
- `minAbsEdge` (latest thesis `|edge_c|`; markets without a thesis pass only when unset)
- `skipIfResearchedWithinHours` (default 24)
- `includeConditionIds: string[]`, `excludeConditionIds: string[]`
- `sort: "vol24h" | "edge" | "endDate" | "priority"` (default `priority`), `limit` (1–50, default 10)

### Steering

- `question: string` (≤ 2000 chars) — operator's own question/thesis, appended to every agent's user prompt and the judge prompt as "Operator focus".
- `roles: RoleKey[]` — subset of built-in roles (`rules, source, base_rate, news, red_team`), at least 1.
- `customRoles: {key, prompt}[]` — up to 5 extra roles with operator-written system prompts (key `^[a-z][a-z0-9_]{1,23}$`, not colliding with built-ins). Total roles ≤ 10.
- `models: Partial<Record<roleKey | "judge", string>>` — model per role; must be in the allowed list exported by `@pm/agents` (current Claude models in `router.ts`). Missing → `DEFAULT_MODELS` / settings override.
- `maxCostUsd: number` (optional, per pod) — once cumulative agent cost reaches it, queued roles are skipped (not started); the judge still runs on what completed.
- `exaCallCap`, `maxTurns` (optional, bounded to settings limits).

Pod success threshold becomes `min(3, roleCount)` agents OK.

Default steering = today's behavior (5 built-in roles, no question, default models). It is a code constant, not a DB row.

## API (operator-auth via existing proxy; zod `.strict()` on all bodies)

- `GET /api/research/profiles`, `POST /api/research/profiles`
- `GET|PUT|DELETE /api/research/profiles/[id]`
- `POST /api/research/profiles/preview` — body `{filter}` → matching markets (id, question, vol24h, spread, end date, edge) without running anything
- `POST /api/research/profiles/[id]/run` — runs the profile now (respects budget/locks), returns 202 with queued market ids
- `POST /api/markets/[id]/research` — body optional `{profileId?, steering?: Partial<Steering>}`; empty body = old behavior (back-compatible for TUI `r`)
- `GET /api/research/models` — allowed model ids + built-in role keys (for the UI)

## Cron

The `research` job: after `researchShortlist`, iterates enabled profiles whose `every_min` has elapsed since `last_run_at`, evaluates the filter, and runs pods in waves with that profile's steering. Budget exhausted → stop, try again next tick. `last_run_at` set when the profile's run is attempted.

## UI (operator web app only)

- New nav item **Research** → `/research`: profile list (name, enabled toggle, schedule, last run, match count) and a profile editor (filter section, steering section, schedule). Editor has **Preview matches** and **Run now**.
- Market page: the "Re-research" action opens a drawer with a steering form, prefilled from a chosen profile or default; submit launches the ad-hoc run.
- Fleet: each pod row shows its profile name (or "ad-hoc" / "screener") and the operator question when present.
- TUI: no new UI; fix `apps/tui/src/views/fleet.tsx` role list to the real role keys and render unknown/custom roles instead of dropping them.

## Out of scope

Public-facing research triggers, TUI profile editing, non-Anthropic models, per-profile budgets beyond `maxCostUsd`.

## Done

- `bunx turbo typecheck` and `bunx turbo test` green.
- New vitest coverage: filter evaluation (each predicate + sort/limit), steering → pod (role subset, custom roles, question injected into prompts, per-role models, cost cap skips queued roles, success threshold), API zod rejects bad bodies, back-compat empty-body research POST.
- Migration `0007` generated and applies on fresh PGlite.
- Manual check in the running app: create a profile, Preview shows markets, Run now creates pods visible in Fleet with profile name + question; ad-hoc steered run from a market page appears in Fleet with its steering.

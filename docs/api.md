# HTTP API contract (build 1)

All routes require the session cookie or `Authorization: Bearer <jwt>` (see `apps/web/proxy.ts`), except `/api/login`, `POST /api/proposals/:id/push` (single-use token, no session), `/api/cron/*` (CRON_SECRET bearer, at least 32 bytes) and, only when `VERCEL` is set, `/.well-known/workflow/*` (Vercel verifies queue signatures; self-hosted keeps the session guard).
Response bodies are the return values of `apps/web/lib/jobs/read.ts` (types exported there), JSON, camelCase.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/watchlist | `tab=small-cap\|size\|structural`, `sort=rank\|edge\|r_ann\|days`, `muted=1` | `WatchlistRow[]` or `StructuralRow[]` |
| GET | /api/markets/:id | — | `marketDetail` or 404 |
| POST | /api/markets/:id/research | optional `{profileId?, steering?}` (zod strict; `steering` = `Partial<Steering>`). Steering = (profile steering, else `DEFAULT_STEERING`) shallow-merged with the override, re-validated. Empty body = old behavior (screener defaults, nothing persisted on the pod) | 202 `{started, conditionId}`; 400 `{issues}`; 404 unknown market or `profileId`. The pod stores `profile_id` + resolved `steering` |
| POST | /api/markets/:id/flags | `{pinned?, muted?}` | `{ok:true}` |
| GET | /api/fleet | — | `fleet` |
| GET | /api/calibration | `category`, `model`, `sinceDays` | `calibration` |
| GET | /api/paper | — | `paperBook` |
| POST | /api/paper/:positionId/close | — | `{ok, realizedPnl}` (closes paper position at current best bid) |
| GET | /api/autonomy | — | `autonomy` (incl. `mode`, `executionEnabled`, `exchangeConfigured`, `pendingCount`, `liveOpenOrders`, `recon`) |
| POST | /api/autonomy/mode | `{to:"L0".."L4", reason?}` | `{allowed, mode, reason}` (L2 needs a configured exchange; L3/L4 → allowed:false, EXECUTION_DISABLED) |
| POST | /api/autonomy/kill | — | `{mode:"L0", cancelled, failed:[{orderId,error}]}` |
| GET | /api/proposals | — | `{pending, recent}` (pending = awaiting decision or sending; recent = last 10 resolved) |
| POST | /api/proposals/:id | `{action:"approve"\|"reject", via:"web"\|"tui"}` (via defaults to web) | `{ok, state, reason?, error?, orderId?}`; 404 `NOT_FOUND`; 409 `{error}` |
| POST | /api/proposals/:id/push | `{action, token}`; no session, single-use token from the ntfy action | `{state}`; 403 `{error:"invalid"}`; 409 `{error:"refused"}`; 429 rate limit |
| GET | /api/book/live | — | `{positions, openOrders, fills, recon}` |
| POST | /api/recon/rebaseline | optional `{ack?: boolean}` | 200 `{ok, at, diff}` (`diff`: exchange vs DB positions, `"none"` if equal); 400 `{error, issues}`; 409 `{error, needsAck, diff?}`: `needsAck:true` = a failed_unknown live order is newer than the baseline, so check the venue and re-POST `{ack:true}`; other 409s have `needsAck:false` and no `diff` |
| GET | /api/settings | — | `AppSettings` |
| PUT | /api/settings | partial `AppSettings` | `AppSettings` or 400 `{issues}` |
| GET | /api/research/profiles | — | `ResearchProfile[]` (by name) |
| POST | /api/research/profiles | `{name, enabled?, filter?, steering?, everyMin?}` (zod strict; defaults: disabled, `{}` filter, `DEFAULT_STEERING`, manual only) | 201 `ResearchProfile`; 400 `{issues}`; 409 `{error:"name_taken"}` |
| GET/PUT/DELETE | /api/research/profiles/:id | PUT: same body as POST (full replace) | `ResearchProfile` / `{ok:true}`; 404; PUT 400/409 as POST |
| POST | /api/research/profiles/:id/run | — | 202 `{queued: conditionIds}` (filter matches now); pods run after the response in budget-bounded waves with the profile steering, trigger `profile`; sets `last_run_at`; 404 |
| POST | /api/research/profiles/preview | `{filter}` | `Match[]` `{conditionId, question, vol24h, spread, endDate, edgeC}` for active markets passing the filter; runs nothing |
| GET | /api/research/models | — | `{models, roles}`: allowed model ids and built-in role keys |
| GET | /api/stream | — | SSE: `event: <type>` per `lib/jobs/events.ts`, `data: <json>`; `event: ping` every 15 s. Live-execution types: `proposal.created`, `proposal.updated`, `order.updated`, `order.filled`, `order.error`, `recon.done`, `mode.changed` |
| POST | /api/login, /api/logout | see auth | |
| GET/POST | /api/cron/{sweep,snapshot,screen,research,paper,calibrate,propose,expire,sync,reconcile} | CRON_SECRET bearer | `{started:true, runId}` or `{skipped, reason}`. `research` also runs enabled profiles whose `every_min` elapsed since `last_run_at` (after the screener shortlist; stops on budget exhaustion) |

Web server components may call `read.*` directly (same server, no HTTP hop). Client components and the TUI use HTTP. Nothing is computed client-side except formatting.

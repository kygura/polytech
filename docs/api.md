# HTTP API contract (build 1)

All routes require the session cookie or `Authorization: Bearer <jwt>` (see `apps/web/proxy.ts`), except `/api/login`, `POST /api/proposals/:id/push` (single-use token, no session), `/api/cron/*` (CRON_SECRET bearer, at least 32 bytes) and, only when `VERCEL` is set, `/.well-known/workflow/*` (Vercel verifies queue signatures; self-hosted keeps the session guard).
Response bodies are the return values of `apps/web/lib/jobs/read.ts` (types exported there), JSON, camelCase.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | /api/watchlist | `tab=small-cap\|size\|structural`, `sort=rank\|edge\|r_ann\|days`, `muted=1` | `WatchlistRow[]` or `StructuralRow[]` |
| GET | /api/markets/:id | — | `marketDetail` or 404 |
| POST | /api/markets/:id/research | — | `researchMarket` result (202 while running) |
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
| POST | /api/recon/rebaseline | — | 200 `{ok, at}`; 409 `{error}` |
| GET | /api/settings | — | `AppSettings` |
| PUT | /api/settings | partial `AppSettings` | `AppSettings` or 400 `{issues}` |
| GET | /api/stream | — | SSE: `event: <type>` per `lib/jobs/events.ts`, `data: <json>`; `event: ping` every 15 s. Live-execution types: `proposal.created`, `proposal.updated`, `order.updated`, `order.filled`, `order.error`, `recon.done`, `mode.changed` |
| POST | /api/login, /api/logout | see auth | |
| GET/POST | /api/cron/{sweep,snapshot,screen,research,paper,calibrate,propose,expire,sync,reconcile} | CRON_SECRET bearer | `{started:true, runId}` or `{skipped, reason}` |

Web server components may call `read.*` directly (same server, no HTTP hop). Client components and the TUI use HTTP. Nothing is computed client-side except formatting.

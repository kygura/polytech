# HTTP API contract (build 1)

All routes require the session cookie or `Authorization: Bearer <jwt>` (see `apps/web/proxy.ts`), except `/api/login` and `/api/cron/*` (CRON_SECRET bearer).
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
| GET | /api/autonomy | — | `autonomy` |
| POST | /api/autonomy/mode | `{to:"L0".."L4", reason?}` | `{allowed, mode, reason}` (L2+ → allowed:false, EXECUTION_DISABLED) |
| POST | /api/autonomy/kill | — | `{mode:"L0", cancelledOrders}` |
| GET | /api/settings | — | `AppSettings` |
| PUT | /api/settings | partial `AppSettings` | `AppSettings` or 400 `{issues}` |
| GET | /api/stream | — | SSE: `event: <type>` per `lib/jobs/events.ts`, `data: <json>`; `event: ping` every 15 s |
| POST | /api/login, /api/logout | see auth | |
| GET/POST | /api/cron/{sweep,snapshot,screen,research,paper,calibrate} | CRON_SECRET bearer | `{started:true, runId}` or `{skipped, reason}` |

Web server components may call `read.*` directly (same server, no HTTP hop). Client components and the TUI use HTTP. Nothing is computed client-side except formatting.

# Polymarket Edge Engine — Build Spec

Rev 6 · 2026-10-18 · public visitor mode (browser wallets, browser-held autonomy key) on top of Rev 5

## Overview

The system scans every open Polymarket market, scores where public research can beat the crowd price, sends an agent fleet to research the top candidates, and ranks the survivors by projected return per unit of risk. Output is a live watchlist with a thesis, a fair probability, an edge, and a suggested size for each market. The system places trades on Polymarket's CLOB. How much it does without a human depends on the **autonomy mode** (see [Execution and autonomy modes](#execution-and-autonomy-modes)). Modes range from observe-only to fully autonomous inside hard risk limits.

**Edge thesis.** Prices are set by whoever trades, not by whoever read the source documents. The gap is widest in:

- **Illiquid markets** (thin books, few traders): a careful read of resolution criteria and primary sources moves fair value a lot. Edge large, capacity small.
- **Liquid markets with asymmetric information**: price anchored to headlines while a primary source (filing, schedule, poll methodology, court docket, on-chain data) says otherwise. Edge smaller, capacity large.

On top of both: resolution-rule mispricing, stale prices after news, and crowd overreaction that a contrarian view can fade.

**Non-goals:** market making, latency arbitrage, anything needing private or insider information. Research uses public sources only.

## Stack and deployment

One TypeScript monorepo on Vercel. Crons trigger durable workflows; long agent runs live in Vercel Sandbox microVMs, not in request functions. All LLM work runs on Anthropic (Claude Agent SDK in sandboxes, Anthropic SDK for orchestrator calls). No other model provider.

| Layer | Choice | Why |
|---|---|---|
| Monorepo | bun workspaces + Turborepo | Shared types between web, TUI and workers |
| Web | Next.js (App Router) on Vercel | Same deploy as API and crons |
| TUI | Ink, talks to the same HTTP API | One API, two clients |
| Scheduling | Vercel Cron → Vercel Workflow | Cron only fires; Workflow holds multi-step state, retries, sleeps |
| Agent runtime | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) inside Vercel Sandbox | Programmatic agent loop with tools, MCP and structured output; sandboxed shell; no 300 s ceiling per agent |
| Orchestrator LLM calls | Anthropic SDK, small structured calls | Scoring, judge, JSON outputs |
| Web research | Exa (search, contents, answer) | Neural search + full-page text |
| DB | Postgres (Neon via Vercel Marketplace) + Drizzle | Markets, snapshots, theses, ledger |
| Cache / locks | Upstash Redis | Cron overlap locks, rate-limit buckets |
| Polymarket | `@polymarket/client` + raw REST | Official TS client for listing |
| Execution | `@polymarket/clob-client` (signed orders, Polygon wallet) | Official client for order placement, cancels, fills |

### Recommended alternatives (advisory, not adopted)

The stack above is the one we build. These are recommendations to reconsider, mostly because live trading puts more weight on reliability and key safety than research alone did.

| Area | Adopted | Recommendation | Reason |
|---|---|---|---|
| Signing key custody | Private key in Vercel env | Remote signer: **AWS KMS** (secp256k1) or **Turnkey**, with a per-day spend policy | A leaked env var drains the wallet. A remote signer limits the damage and logs every signature. |
| Trading wallet | Single wallet | A **dedicated trading wallet** funded only up to bankroll B; sweep profits to cold storage by hand | Caps worst-case loss at B |
| Durable workflows | Vercel Workflow | Keep it. Fallback: Inngest or Trigger.dev if Workflow limits bite | Step logic is kept portable anyway |
| Ledger writes | Drizzle on Neon | Keep, but write order/fill/position changes inside serializable transactions keyed by idempotency key | Prevents double-orders on workflow retries |
| Alerting | SSE to UI only | Add push alerts (ntfy or Telegram bot) for approvals, fills, kill-switch trips | Approvals in L2/L3 can't wait for someone to open the UI |

### Repo layout

```
apps/web        Next.js UI + /api routes + cron handlers
apps/tui        Ink client, reads /api with a bearer token
packages/core   types, scoring, sizing, calibration math (pure, no I/O)
packages/pm     Polymarket clients (gamma, clob, data) + per-host token buckets
packages/agents fleet orchestration, role prompts, sandbox runner, model router
packages/db     Drizzle schema + migrations
```

### Vercel constraints that shape the design

- Functions default to 300 s (Pro: up to 800 s). Each cron handler only takes a lock, starts a workflow, and returns.
- Vercel Cron does not serialize overlapping runs: every job takes a Redis lock first.
- Workflow steps survive redeploys and sleep for free; keep step logic in plain functions so it stays portable.
- Order-book state comes from polling snapshots, not a live stream.
- Region: pin functions to `dub1` (Dublin). Read-only data endpoints work from anywhere.

### Agent auth (Anthropic only)

Each research agent is an Agent SDK `query()` run inside a Vercel Sandbox. Agents and orchestrator calls (judge, R classifier) all authenticate with `ANTHROPIC_API_KEY`. On rate-limit or overload errors the runner backs off and retries; total spend is bounded by the budget knobs.

The **model router** picks a Claude model per role (configurable in Settings). Defaults: research roles on Sonnet, rules reader on Haiku, judge on Opus. Diversity comes from role separation and blind estimation, not from mixing providers.

## Polymarket data layer

Everything the screener needs is public and unauthenticated.

| Need | Endpoint | Limit (req / 10 s) |
|---|---|---|
| Market universe | Gamma `GET /markets/keyset`, `/events/keyset` (cursor) | 300 / 500 |
| Rules, tags, end date, neg-risk group | Gamma market + event detail | 4,000 general |
| Comment sentiment | Gamma `/comments` | 200 |
| Order books, batched | CLOB `POST /books` | 500 |
| Spread, midpoint, last trade | CLOB `/spreads`, `/midpoints`, `/last-trades-prices` (≤ 500 tokens/call) | 500–1,500 |
| Price history | CLOB `/prices-history` (+ batch) | 1,000 |
| Fee rate, tick size, rewards | CLOB `GET /clob-markets` info | 9,000 general |
| Top holders, open interest | Data API v2 `/v2/holders`, `/v2/oi` | 1,000 general |
| Recent trades | Data API v2 `/v2/trades` | 200 |
| Resolution state (UMA) | Gamma resolution-state endpoint | 4,000 general |

Throttled requests are delayed, not rejected, so the client keeps its own token bucket per host.

**Fees in every EV number.** Taker fee per share = `feeRate × p × (1 − p)`, rates 0.04 (politics, finance, tech) to 0.07 (crypto); geopolitics fee-free; makers never pay. Exact rate per market comes from CLOB market info.

**Snapshot cadence:** universe every 30 min; books/prices for the watchlist every 5 min; holders/trades for researched markets every 15 min. Snapshots are append-only.

## Market screener

Two passes: hard filters on the whole universe, then a priority score on survivors. Top 20–40 go to the fleet.

**Pass 1 — hard filters (pure code):**
- Open, accepting orders, not in UMA dispute
- Resolves in 2–120 days (configurable)
- ≥ $200 depth within 5¢ of mid on the side traded
- Excluded categories by config (e.g. sports in-play, 15-min crypto up/down)

**Pass 2 — priority:** `Priority = R × I × L × T × (1 + 0.5·C)`

| Factor | Measures | Inputs |
|---|---|---|
| R researchability (0–1) | Can public sources settle it? | Fast Claude (Haiku) classifier on rules text: objective source, scheduled event, public data release, rule ambiguity. Cached per market until rules change. |
| I inefficiency (0–1) | Price not being worked | Spread width, hours since last trade, drift vs. siblings, round-number pinning, longshot zone (p < 0.07 or > 0.93) |
| L liquidity fit (0–1) | Can target size fill? | Depth to fill target within 3¢ slippage, OI, 24h volume |
| T time value (0–1) | Return per day of capital | Days to resolution, decays past 60 days |
| C crowding (0–1) | One-sidedness | Top-10 holder share, net taker flow 24h, comment sentiment skew |

L is computed against two size targets; each market is tagged **small-cap** or **size** and ranked in separate lists.

**Free-edge detectors (every sweep, no research):**
- Neg-risk sum: in a mutually exclusive group, Σ best asks < 1 − fees → buy-all locks profit; Σ best bids > 1 → the reverse.
- Monotonic ladders: "X by March" priced above "X by June".
- Mirror markets: same question listed twice at different prices.

These go to the watchlist with a structural tag and no thesis.

## Research fleet

Each shortlisted market gets a pod: five Agent SDK agents with fixed roles, then a judge. Agents estimate blind: no market price in their brief.

| Role | Job | Output | Default model |
|---|---|---|---|
| Rules reader | Parse resolution text, source, edge cases, likely crowd misreads | Resolution checklist, ambiguity flags | Haiku |
| Primary-source hunter | Find the document/schedule/dataset/docket that settles it | Sourced facts with dates | Sonnet + Exa |
| Base-rate analyst | Reference classes, historical frequencies; runs small scripts | Prior with method | Sonnet |
| News and flow scanner | Last 7 days of news; is it priced in? | Event timeline | Sonnet + Exa |
| Red team | Argue the other side; break the thesis | Counter-case, kill criteria | Sonnet |
| Judge | Merge evidence, then see price; output fair probability | p̂, confidence, thesis, catalysts | Opus (SDK call) |

**Pod run:**
1. Workflow step creates one Sandbox per agent with a role prompt and a JSON brief (question, rules, tags, end date, sibling markets). No price.
2. Agents use Exa via an MCP server inside the sandbox. Every claim carries a URL and retrieved-at time.
3. Each agent returns a strict JSON result (Agent SDK structured output); validated with Zod, one retry on schema failure.
4. The judge gets all five results, then the current book. **Disagreement cap:** if the probability-bearing agents' estimates straddle `p_mid` (at least one above and one below), confidence is capped at 0.5.

**Evidence ledger:** every fact stored with URL, quote < 25 words, date, agent role. UI shows it beside the thesis.

**Re-research triggers:** price moves > 8¢ since thesis; a catalyst date passes; new high-relevance Exa hit on a saved query; thesis > 72 h old with < 14 days to resolution.

**Calibration loop:** every judge estimate stored with the market price at the time. Nightly job computes Brier and log loss by category, role mix and model. Those set confidence `c` per category; `c ≤ 0.4` until a category has 30 resolved forecasts.

## Sizing and projected returns

Formulas for buying YES; NO uses 1 − p throughout. All against the real book and fees, not mid.

1. `p_post = c·p̂ + (1 − c)·p_mid`
2. `k(S) = VWAP_asks(S) + feeRate·p(1 − p)`
3. `e(S) = p_post − k(S)`, `r(S) = e/k`, `payoff = (1 − k)/k`
4. `r_ann = (1 + r)^(365/d) − 1`, displayed capped at 500%
5. `f* = (p_post − k)/(1 − k)`; `S = min(¼·f*·B, 0.05·B, S where e ≥ 0.02)`
6. `Rank = e(S)·S / d × (1 + 0.2·C_against)`; `C_against` = C when trade opposes the crowd, else 0

Each watchlist row: p_mid, p̂, p_post, edge (¢), size, expected profit (USD), annualized return, payoff ratio, days left, next catalyst.

## Execution and autonomy modes

One global mode, plus optional stricter per-category overrides. A category override can only lower autonomy, never raise it.

| Mode | Name | Behavior |
|---|---|---|
| L0 | Observe | Watchlist only. No orders, no paper fills. |
| L1 | Paper | Every qualifying thesis gets a hypothetical fill at k(S). Realized edge is tracked. No real orders. |
| L2 | Approve each | Real orders are proposed with thesis, size, limit price and expected profit. Each needs explicit approval (web, TUI, or push alert) before it is sent. Proposals expire after 15 min or when the price moves > 2¢. |
| L3 | Bounded auto | Orders inside auto-limits go out without approval. Anything above a limit falls back to L2 approval. |
| L4 | Full auto | All qualifying orders go out automatically, but only inside the global risk limits. The kill switch and auto-downgrade still apply. |

**Qualifying order:** a thesis with `e(S) ≥ 0.02`, judge confidence above the category threshold, no disagreement cap tripped, a fresh book snapshot (< 60 s at order time), and a market that still passes the Pass 1 filters.

**Risk limits (Settings, enforced server-side in every mode ≥ L2):**
- Per-trade max (USD and % of B). The default is the sizing cap `0.05·B`.
- Per-market max position, per-event max (neg-risk groups count as one event)
- Per-category max exposure, total open exposure max
- Daily max notional sent; daily max realized loss
- L3 auto-limits: per-trade auto ceiling, daily auto notional, category allowlist, structural trades allowed yes/no

**Order policy:**
- Limit orders only, priced at the VWAP level that sizing used, never worse than `p_post − 0.02`. No market orders.
- GTD orders that expire at the earlier of thesis `expires_at` and 24 h. Unfilled remainder is cancelled when the thesis is re-researched or killed.
- Structural (neg-risk) trades go out as a set. If any leg fails to fill within its window, the filled legs are unwound or flagged for manual action.
- Every order carries an idempotency key `(thesis_id, attempt)` so workflow retries can't double-send.
- Exits: when a kill criterion fires or the thesis flips sign, an exit is proposed (L2) or placed (L3/L4 within limits).

**Mode gates (escalation).** Moving up requires evidence:
- L1 → L2: phase-5 gate met (50 resolved forecasts, Brier below market at thesis time).
- L2 → L3: ≥ 30 approved live trades, with realized slippage within 1¢ of modeled k(S) on average.
- L3 → L4: ≥ 100 live trades and positive realized edge over a 30-day window.

Gates are shown in Settings. Gates are advisory: the mode can be set regardless, and skipping a gate is logged.

**Safety controls:**
- **Kill switch:** one action (web button, TUI `K`, push-alert reply) drops to L0 and cancels all open orders.
- **Auto-downgrade** to L2 (or L0 for the first two): daily loss limit hit; 3 consecutive order errors; book data stale > 5 min; wallet balance mismatch vs. ledger; Anthropic API outage that halts research mid-pod.
- Mode changes are one action (no re-auth), written to `autonomy_events`, and trigger a push alert.
- Reconciliation every 5 min: on-chain/CLOB positions and USDC balance vs. the `positions` table. A mismatch halts new orders.

## Interfaces

Web and TUI are two clients of one HTTP API. Nothing computed client-side except formatting.

| View | Web | TUI |
|---|---|---|
| Watchlist | Tabs: small-cap, size, structural; sortable by rank, edge, r_ann, days left | Same lists, tab to switch, `/` to filter |
| Market detail | Depth chart, price history with thesis markers, thesis, ledger, kill criteria | Thesis, ledger, book as text panes |
| Fleet | Running pods, per-agent status, token spend, Sandbox minutes | Live pod list, logs on enter |
| Calibration | Reliability curve, Brier by category and model | Table only |
| Orders & positions | Pending approvals, open orders, fills, positions with live P&L, realized vs. modeled edge | Same; `a`/`r` approve/reject |
| Autonomy | Current mode, per-category overrides, risk limits, gate progress, kill switch, event log | Mode + gate status, kill switch `K`; approve/reject proposals |
| Settings | Filters, weights, bankroll, Kelly fraction, caps, model per role, risk limits | Read-only (mode change via Autonomy view) |
| Actions | Re-research, pin, mute, approve/reject order, close position | Same, by keybinding |

Live updates via SSE from `/api/stream`; TUI subscribes to the same stream.

## Auth (single user, password)

- `APP_PASSWORD_HASH` (argon2id) in env. `POST /api/login` verifies and sets a signed JWT (jose) in an httpOnly, SameSite=Strict cookie, 7-day expiry.
- Next.js middleware guards every page and `/api/*` except `/api/login` and cron routes.
- Login rate-limited in Upstash: 5 per 15 min per IP.
- TUI: `pm login` prompts for the password, gets a bearer token, stores it in `~/.config/pm-edge/token` with mode 0600.
- Cron routes check `CRON_SECRET` instead of the session.
- Trading wallet key: `POLY_PRIVATE_KEY` plus CLOB API creds (`POLY_API_KEY/SECRET/PASSPHRASE`) in env. A remote signer is recommended (see Recommended alternatives). The key is never sent to sandboxes or agents.

## Data model

Twelve Postgres tables. Snapshots and events are append-only so every score and every trade decision can be replayed.

| Table | Key columns | Written by |
|---|---|---|
| markets | condition_id, event_id, question, rules, category, tags, end_date, neg_risk_group, fee_rate, status | Universe sweep |
| snapshots | condition_id, ts, mid, best_bid, best_ask, depth_5c_usd, vol_24h, oi, top10_share, last_trade_ts | Book/price polls |
| screens | condition_id, ts, R, I, L, T, C, priority, tier, structural_flag | Screener |
| pods | id, condition_id, started_at, status, trigger, cost_sandbox_s | Orchestrator |
| agent_runs | pod_id, role, model, status, output_json, usage, duration_s | Sandbox runner |
| evidence | pod_id, agent_role, url, quote, published_at, retrieved_at, claim, direction (+/−) | Agents |
| theses | condition_id, pod_id, p_hat, c, p_post, side, edge_c, size_usd, r_ann, rank, catalysts[], kill_criteria[], expires_at | Judge + sizing |
| outcomes | condition_id, resolved_at, result, brier, log_loss | Nightly calibration |
| orders | id, thesis_id, idempotency_key, condition_id, token_id, side, limit_price, size, mode_at_send, approval (auto/user/null), status, clob_order_id, expires_at | Execution |
| fills | order_id, ts, price, size, fee, tx_hash | Execution / fill listener |
| positions | condition_id, token_id, size, avg_cost, realized_pnl, opened_at, closed_at, paper (bool) | Execution + reconciliation |
| autonomy_events | ts, from_mode, to_mode, scope (global/category), reason, actor (user/auto-downgrade/kill) | Autonomy controller |

**Agent output contract** (Zod, every run):

```ts
{
  role: "rules" | "source" | "base_rate" | "news" | "red_team",
  probability: number | null,   // null for rules reader
  confidence: number,           // 0..1, self-reported
  key_facts: { claim, url, quote, date }[],
  risks: string[],
  notes: string                 // ≤ 150 words
}
```

## Build phases

1. **Data + screener.** Universe sweep, snapshots, scoring, structural detectors, web watchlist, password auth. Gate: full sweep < 60 s, structural list populated.
2. **One-agent research.** One Agent SDK agent per market in Sandbox, judge, sizing math, evidence ledger. Gate: 20 theses with sourced ledgers.
3. **Full pods.** Five roles, model router, blind estimation, disagreement cap, re-research triggers.
4. **TUI + calibration.** Ink client; nightly Brier and reliability charts.
5. **Paper book (L1).** Autonomy controller, risk-limit engine, and hypothetical fills at k(S); track realized edge. Gate: 50 resolved forecasts with lower Brier than market price at thesis time.
6. **Live execution (L2).** CLOB client, order/fill/position tables, approval flow with push alerts, kill switch, reconciliation. Gate: 30 approved trades with slippage within 1¢ of model.
7. **Autonomy (L3/L4).** Auto-limits, auto-downgrade triggers, exits on kill criteria, mode-gate tracking.

**Budget knobs** (Settings, enforced by orchestrator): max pods/day, max concurrent sandboxes, sandbox timeout (default 10 min/agent), Exa calls per pod, daily Anthropic spend cap (hard stop).

## Open decisions

- [ ] Vercel plan: Hobby caps functions at 300 s and limits cron frequency; Pro likely needed for 5-minute polls.
- [ ] Execution legality: Spain's regulator ordered ISPs to block Polymarket (May 2026). Read-only API use from Dublin is unaffected. Confirm that order placement is permitted for the operator's jurisdiction and from `dub1` (Polymarket geoblock list and ToS) before phase 6.
- [ ] Key custody: env var vs. KMS/Turnkey remote signer (recommended).
- [ ] Default risk-limit values and the starting bankroll B.
- [ ] Exa plan tier and per-pod call cap.

## Public visitor mode (Rev 6, 2026-10-18)

The app is deployed at a public URL. Anonymous visitors see the LLM-scouted watchlist and theses, connect their own wallet, and trade from their browser. The server stays single-tenant: it runs scouting for everyone and holds no visitor keys and no visitor state. Operator pages, settings, the server wallet and the operator autonomy controller stay behind the existing login.

**Custody (planner default, not yet confirmed by the user).** Visitor keys never reach the server. Manual trades are signed by the visitor's connected wallet, one signature per order. Visitor autonomy uses a trading key generated in, and stored only in, the visitor's browser; the visitor funds it with a capped amount, and the loop runs only while the tab is open. Considered and not chosen by default: server-held wallets per visitor (custodial), and autonomy for the operator only (a subset of this design).

### Flows

1. **Browse.** `/` redirects anonymous visitors to `/trade`. The watchlist comes from `GET /api/public/watchlist`, polled every 60 s. Market detail at `/trade/[id]` comes from `GET /api/public/markets/[id]`. Public payloads are projections that leave out operator sizing, pin/mute flags, the paper/live book, agent usage, cost and model, and pod internals. The public API is rate-limited per IP.
2. **Connect.** The visitor connects an injected EIP-1193 wallet (viem custom transport, Polygon). WalletConnect is deferred. There is no app-side geoblock check (personal tool; Polymarket enforces its restrictions server-side). Orders go from the browser straight to Polymarket's CLOB, never through our server.
3. **Manual trade.** The ticket is prefilled from the thesis: side, limit price from `livelimitPrice`, and size from `sizeTrade` using the visitor's bankroll and Kelly settings. The wallet signs CLOB auth once per session and then signs each order. Positions, open orders (with cancel) and balance are read through the CLOB client.
4. **Visitor autonomy.** Modes: Manual (default), L2 approve each, L3 bounded auto (inside `limits.l3`), L4 full auto inside the risk limits. Settings live in the visitor's localStorage and are validated with the core zod schema. The loop reuses `packages/core` (`sizeTrade`, `checkOrder`, `autoAllowed`, `livelimitPrice`, fees). The kill switch stops the loop and cancels open orders. There is no local paper book.
5. **Scouting (server).** The pipeline is unchanged: sweep, snapshot, screen, research pods, judge. Production refuses the fake runner: with no `ANTHROPIC_API_KEY`, research is skipped with an explicit status. With no `EXA_API_KEY`, agents use the Agent SDK's built-in web search. The daily Anthropic spend cap is enforced as before.

### Deployment (Vercel Hobby)

- Project `polytech` with root directory `apps/web`; dependencies install from the repo root with bun. Neon Postgres and Upstash Redis come from the Vercel Marketplace free tiers. Migrations run during the deploy step.
- Hobby allows only daily crons. The scouting crons run daily, and the trading crons (paper, propose, sets, expire, sync, reconcile) are removed from `vercel.json`. A public watchlist read starts the scouting chain when the last sweep is older than 30 minutes, under a Redis lock so only one chain runs at a time. On Pro, restore the Rev 5 schedule.
- Functions are pinned to `arn1` (Stockholm), which is not on Polymarket's restricted list (docs.polymarket.com/api-reference/geoblock). The `dub1` pin was dropped because Ireland is restricted.

### Done

- The production URL serves `/trade` with a watchlist built from live Polymarket data. `/api/public/*` returns projected JSON, operator pages redirect to `/login`, and cron routes return 401 without the secret.
- A visitor with an injected wallet on Polygon, in a non-restricted jurisdiction, can derive CLOB credentials and place and cancel a limit order. This is verified by a person, because the build machine cannot reach Polymarket.
- `bun install && bunx turbo typecheck test build` is green, including unit tests for the visitor autonomy decision function against a fake exchange.
- Scouting test runs: research pods run on at least 8 live markets across at least 4 categories on the deployed instance, with results in `docs/research/scouting-test-runs.md`. Blocked until `ANTHROPIC_API_KEY` is provided.

## Trading terminal redesign — public `/trade` (2026-10-18)

The public `/trade` surface becomes a single-screen, multi-pane trading terminal. The operator app is out of scope and keeps its current look.

**Panes (one screen, no route transition to trade):** market list/search, live order book with a clickable price ladder, price chart, live trade tape, keyboard-driven trade ticket, and the visitor's positions and open orders. Selecting a market swaps pane contents in place.

**Live data:** the server proxies a live feed for the selected market (book levels, mid/last price, recent trades) through `@pm/pm`; clients never call Polymarket directly. Tick size comes from the market, not a hardcoded 0.01; the ticket rounds and validates to it.

**Keyboard:** order entry, side switch, price nudge by tick, size entry, and submit are reachable without the mouse. Existing wallet connect, region gate and signing flow are reused unchanged.

**Visual direction:** a new terminal design system chosen by the user from 2–3 rendered directions (dense, numeric-first, monospaced figures, dark-first). The chosen tokens supersede `DESIGN.md` §10 for `/trade`.

**Done:** `bun run build`, `bun run typecheck`, `bun run test` green; `/trade` verified in a real browser (live book updates, keyboard order path reaches the signing step, correct tick on a 0.001 market) and checked for drift against the approved mockup.

## Rev 7 — Polyscout merge (2026-10-20)

Polyscout (sibling repo, Hono + pg-boss + Vite) is folded into polytech. The result is one web terminal on polytech's stack: Next.js on Vercel (arn1), Drizzle over Neon/PGlite, Bun + turbo + vitest. No Hono, pg-boss, Postgres-only features (partitions, LISTEN/NOTIFY) or Vite app come over; their ideas are re-expressed in this stack. The TUI is out of scope.

### What comes over

1. **Polymarket client hardening** (`packages/pm`): FIFO token bucket with 429 penalty and `Retry-After`, tolerant zod response parsing with string/JSON coercion, `POST /books` batching, `prices-history`, Data API holders and trades, Gamma events for neg-risk siblings, an isomorphic CLOB market-channel WebSocket client, and fixture contract tests. Written up in `docs/polymarket-api.md`.
2. **Scoring upgrades** (`packages/core`): polyscout's book metrics (spread, depth at 1/2/5c, slippage curve, capacity, exit depth, complement book), its structural detector (ladder parsing from question text, executable neg-risk overround net of fees, sibling-sum inconsistency, augmented-event guard), crowd metrics (holder HHI/top1/top5, signed 24h taker flow, median ticket, large-trade flag), and the sizing refinements: fee charged per book level, both sides evaluated via the complement book, exit-depth factor, contrarian flag. `sizeTrade` stays the single sizing entry point used by trading; its signature does not change.
3. **DSL screener**: `parseQuery`/`formatQuery` in core, a `/api/markets?q=` endpoint that compiles a `Filter` to SQL, saved views, and a Screener view with a highlighted query bar, hints, filter panel, column picker and a virtualized table.
4. **Journal + alerts**: per-thesis journal rows (model, pre-reveal and market Brier, log loss, 24h/7d drift, paper P&L), breakdowns by category, liquidity band, model and R bucket, a paper P&L curve, an extremize refit suggestion (applied only from Settings), and an alerts feed (mid move since thesis, catalyst passed, new candidate, structural arb) with ack and ack-all.
5. **Live runs view**: per-agent status rows written as agents start and finish, captured tool calls, cost meter, stage stepper (rules → agents → judge → sizing → done), and cancel.
6. **Optimisations**: incremental sweep upsert (rewrite a market only when a field changed; liquidity/volume only on a >5% move), a `market_latest` table updated in place by the snapshot job with a skip-if-unchanged rule for snapshot history, in-flight-deduped short caches on the structural scan and price history, login lockout with exponential backoff, an SSRF guard on agent URL fetches, and CI (typecheck + test on push/PR).

### Unified terminal

One shell for everything an authenticated operator does. Nav: Screener, Watchlist, Trade (`/trade`), Runs (was Fleet), Research, Journal (was Calibration), Book, Autonomy, Settings. A status bar shows active runs, today's spend against budget, ingest age, unacked alerts, SSE state and a UTC clock. The public `/trade` terminal keeps working anonymously; when a session exists it shows a link back into the operator shell. The `/trade` live book upgrades to the CLOB WebSocket when it connects and falls back to the existing 3 s poll.

### Data model additions (migration 0009)

- `markets`: `liquidity` dp, `rules_hash` text, `resolution_source` text (heuristic classifier: official_data | scheduled_event | media_report | subjective | unknown), `neg_risk_augmented` bool default false.
- `market_latest` (one row per market, updated in place): `condition_id` PK, `ts`, `mid`, `best_bid`, `best_ask`, `spread`, `depth_1c`, `depth_2c`, `depth_5c`, `exit_depth`, `capacity`, `book_hash` text, `mid_changed_at`, `holder_count` int, `holder_hhi`, `top1_share`, `top5_share`, `flow_24h`, `trade_median`, `large_trade_24h` bool, `last_trade_ts`, `priority` (latest screen score), `structural` jsonb string[] (structural kinds this market is in), `opportunity` jsonb (`{side, edge, stake, o, contrarian}` or null).
- `views`: `id` text PK, `name` text unique, `query` text, `columns` jsonb string[], `created_at`.
- `alerts`: `id` bigserial PK, `condition_id` text null, `kind` text (mid_move | catalyst_passed | new_candidate | structural | run_failed), `message` text, `data` jsonb, `created_at`, `acked_at` null. Index on (`acked_at`, `created_at`). Dedupe: same kind + market not re-raised within 6 h.
- `journal`: `thesis_id` text PK, `condition_id`, `category`, `model`, `p_hat`, `p_pre` (mean of blind agent estimates), `mid_at`, `liquidity_at`, `r`, `side`, `stake`, `result` text null, `resolved_at` null, `brier_model`, `brier_market`, `brier_pre`, `log_loss`, `drift_24h`, `drift_7d`, `paper_pnl`. Filled by the calibrate job.
- `pods`: `cancel_requested_at` ts null; status gains `cancelled`; `stage` text (rules | agents | judge | sizing | done).
- `agent_runs`: `started_at`, `finished_at` ts null; status gains `running` and `cancelled`; `tool_calls` jsonb (`{ts, name, input (≤500 chars), ok}[]`, capped at 200 entries).
- Settings additions: `extremize` (default 1, applied to p̂ in logit space before the blend), `suggested` `{extremize, n, at}` or null, `alerts` thresholds `{midMoveC: 5, cooldownH: 6}`.

### DSL fields (polytech mapping)

`liq` → markets.liquidity, `vol24h` → markets.vol_24h, `depth` → market_latest.depth_2c, `spread`, `price` (mid), `days` (end_date − now), `stale` (hours since last trade), `top1`, `holders`, `tag`, `cat` (category), `src` (resolution_source), `struct`, `prio` (priority), `opp` (opportunity.o), `edge` (opportunity.edge), `sort`, `is:watch|pinned|muted`, `has:thesis`, `limit`, `offset`. Unknown keys are errors with a nearest-key suggestion.

### Scheduling

Vercel Hobby allows only daily crons, so a new `monitor` job (alerts) runs at the tail of every watchlist snapshot and from the existing GitHub Actions heartbeat (`scout.yml`, every 30 min, `Authorization: Bearer $CRON_SECRET` when set). The SSE bus stays in-process; views that must be live across instances (runs, alerts) poll.

### Done (Rev 7)

- `bun run typecheck` and `bun run test` green from a fresh checkout, including the two previously clock-dependent `sendEntry ledger` tests.
- CI workflow runs both on push and PR.
- `bun run build` succeeds for `apps/web`.
- With `PM_FIXTURES=1` and no API keys: a sweep → snapshot → screen → monitor cycle fills `market_latest` and alerts; `/api/markets?q=liq:1k.. sort:-prio` returns rows; the Screener, Runs (fake runner pod visible with agent rows and stage), Journal and alerts views render; a running pod can be cancelled.

## Rev 8 — One app, one design system (2026-10-20)

Owner feedback on Rev 7: the operator pages and the `/trade` terminal look like two different products stitched together (two palettes, two fonts, two shells, two market pages), the market panels truncate titles and have no usable YES/NO chart, and many flows are broken. Rev 8 replaces "two palettes, one set of shapes" (DESIGN 12.1.1) with one system and one shell.

### Decisions

- **No login.** The password gate, `/login`, `/api/login`, `/api/logout` and the session cookie are removed. Every page and API route is reachable without credentials. Cron routes keep `CRON_SECRET`. The TUI stops asking for a password. Risk accepted by the owner: anyone with the URL can change autonomy mode and, if `PM_PRIVATE_KEY` is set, trade the server wallet; the kill switch stays one click away in the header.
- **No visitor mode.** The `(public)` route group, `PublicShell`, the "Sign in" link and `/trade/autonomy` are removed. `/trade` moves under the single app shell. Browser-wallet trading on `/trade` stays (wallet button lives in the shell header). The read-only `/api/public/*` routes may stay as the terminal's data API.
- **One shell.** Every route renders inside the same header (logo, nav, market search, theme, mode badge, wallet, kill switch) and the same bottom status bar. Workspace pages (Trade) fill the viewport between them; document pages scroll.
- **One token set.** One palette (the terminal's, dark default, light via toggle), one UI font (Inter) and one numeric font (JetBrains Mono, tabular), loaded once in the root layout. No page-scoped token namespace (`--t-*` folds into the global tokens). Theme resolution: stored choice, else dark.
- **One market page.** `/trade/[id]` is the market page. `/markets/[id]` redirects to it. The operator's research content (thesis, edge, kill criteria, catalysts, evidence, agent estimates, research actions, metrics, flags) becomes a tab set on the market page beside positions, orders and rules.
- **YES/NO chart.** The market chart plots YES and NO probability (NO = 1 − YES) from `/api/markets/[id]/history` (Polymarket prices-history, snapshot fallback) with 1D / 1W / 1M / ALL ranges, a crosshair tooltip (time, YES ¢, NO ¢), a 0–100 % axis with distinct ticks, the live mid as the last point, thesis fair value (p̂) and entry markers when a thesis exists.
- **Titles never crop to one line.** Market titles wrap (at most two lines in lists, full in headers) with the full question in a tooltip.
- **Querying markets.** The market list on `/trade` searches all tracked markets (not just the watchlist) by name; `/markets` (screener) keeps the DSL query bar and filter panel, gains YES / NO price columns and a probability bar, wraps titles, and fits its container without horizontal page overflow.

### Done (Rev 8)

1. `bun run typecheck`, `bun run test` and `bun run build` (apps/web `next build`) pass.
2. With `AUTH_DISABLED` unset and no password configured, every page in the nav loads with HTTP 200 and no redirect to `/login`; `/login` is gone (404 or redirect home).
3. A Playwright pass over every nav route (fresh PGlite DB after sweep/snapshot/screen/research jobs) shows no page errors, no failed same-origin requests, and the same header/status bar/fonts/colors on every route, including `/trade`.
4. On `/trade/[id]` the chart shows YES and NO lines from Polymarket history with working range tabs and hover tooltip; titles are not cut to one line; the research tab shows the thesis for a researched market.
5. `/markets/[id]` lands on `/trade/[id]`.
6. Bugs listed in `docs/rev8-audit.md` are fixed or explicitly deferred there with a reason.

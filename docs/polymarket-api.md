# Polymarket API: how polyscout connects, and what polytech adopted

Polymarket exposes four public hosts. Both projects talk to all of them without credentials (order placement is separate: `packages/pm/src/exchange.ts` wraps `@polymarket/client`). This note describes each host as polyscout (`/home/user/tor-mask-cli/packages/polymarket/src`) and polytech (`packages/pm/src`) use it, then lists what polytech took over. Live shapes below were re-verified against the APIs on 2026-10-20; the recordings live in `packages/pm/fixtures/contract/`.

## Gamma (`https://gamma-api.polymarket.com`): market and event catalogue

Endpoints used:

- `GET /markets/keyset` and `GET /events/keyset`: cursor pagination. The response is `{markets|events: [...], next_cursor}`; the cursor is opaque, `next_cursor` is absent on the last page, and the API has been seen to repeat a cursor (polytech stops on a repeat). Filters are query params (`closed`, `liquidity_num_min`, `end_date_min/max`, `tag_id`, `tag_slug`, `limit` up to 100). There is no `active` filter on `/markets/keyset`; polyscout applies `active` client-side, polytech exposes `open` (`active && !closed && !archived`) and `accepting_orders` on the normalised market. Every page must repeat the filters: the cursor does not encode them.
- `GET /markets/{id}`, `GET /events/{id}`: detail by Gamma id (event detail includes nested markets, which is how neg-risk siblings are discovered: the event carries `negRisk`, `negRiskAugmented`, and each market a shared `negRiskMarketID`).
- `GET /public-search` (polytech only): free-text search used by the operator UI.
- `GET /comments` (polytech only), `GET /tags` (polyscout only).

Shape quirks the parsers must survive: `clobTokenIds`, `outcomes` and `outcomePrices` arrive as JSON-encoded strings (`'["Yes","No"]'`), sometimes as real arrays; numbers are often strings (`"3512.5"`) or absent; booleans may be `"true"`; timestamps are ISO (`2027-01-01T04:59:00Z`) or Postgres style (`2026-10-20 13:05:04.275395+00`). Fee information lives in `feesEnabled`, `feeType` and `feeSchedule: {rate, exponent, takerOnly, rebateRate}`; `feesEnabled=false` means fee-free, a missing `feeSchedule` means unknown, never zero.

Rate limits: the documented budget is 300 requests / 10 s on `/markets` (polytech's bucket). Cloudflare answers bursts with `429` body `1015` and bans for seconds, so polytech paces keyset pages 100 ms apart and never retries a 429 in under 5 s. Polyscout runs 10 req/s with a burst of 20.

## CLOB REST (`https://clob.polymarket.com`): books, prices, venue rules

Endpoints used by both: `POST /books` (array of `{token_id}` bodies, max 500 per call, returns one book per token that has one; tokens without a book are silently absent), `GET /book?token_id=` (404 `No orderbook exists for the requested token id` when none), `POST /midpoints` (`{token_id: "0.9295"}` map), `GET /prices-history?market=<token>&interval=1d|6h|1h|1w|1m|max&fidelity=<minutes>` or `&startTs=&endTs=` (unix seconds; returns `{history: [{t, p}]}` with `t` in seconds), `GET /fee-rate?token_id=` (`{base_fee}`), `GET /clob-markets/{conditionId}` (terse keys: `c` condition, `t[{t,o}]` tokens with outcome, `mts` tick size, `mos` min order size, `ao` accepting orders, `mbf`/`tbf` legacy base fees, and `fd: {r, e, to}` the authoritative taker fee curve, omitted on fee-free markets). Polytech additionally batches `POST /spreads` and `POST /last-trades-prices`; polyscout uses the single-token `GET /spread`, `/midpoint`, `/last-trade-price`.

Book wire format: every number is a string; `bids` come ascending and `asks` descending (worst first), so both projects sort best-first before anything reads `[0]`. `timestamp` is milliseconds. `tick_size`, `min_order_size`, `neg_risk`, `last_trade_price` and a `hash` ride along.

Fees: `fee = shares * rate * (p * (1 - p)) ^ exponent`, taker only (polyscout `takerFee`, polytech `takerFee`). `/fee-rate` is legacy: it does not reflect the 2026 fee curve (it returns `1000` for most tokens and `0` for others regardless of `feeSchedule`), so both projects treat Gamma `feeSchedule` or `clob-markets.fd` as the source of truth. Polytech's `feeRateBps()` stays for existing callers but is documented as legacy.

Rate limits: polytech budgets 500 / 10 s (the batch routes' documented limit); polyscout 5 req/s burst 10.

## Data API (`https://data-api.polymarket.com`): holders, trades, open interest

Version matters: v1 (`/holders?market=`, `/trades?market=`, `/oi?market=`, bare arrays, camelCase rows) is scheduled to retire on 2026-10-24. v2 is what polyscout targets: `GET /v2/holders?condition=<id[,id]>&limit=` returns `{data: [{token_id, holders: [{proxy_wallet, amount, outcome_index, name, pseudonym, ...}]}]}` (one group per outcome token, amount = shares, descending, `limit` per token up to 1000). `GET /v2/trades?condition=<id[,id]>&limit=<=1000>&taker_only=false&cursor=` returns `{data: [{proxy_wallet, side: BUY|SELL, token_id, condition_id, size, price, timestamp (seconds), outcome, outcome_index, transaction_hash, ...}], pagination: {has_more, next_cursor}}`, newest first; server-side `start`/`end` filters are ignored on the market feed, so "trades since T" means paging until an older row appears. The cursor does not encode the market: a page fetched with only `cursor=` silently continues the global trade stream, so every page must repeat `condition`/`limit`/`taker_only`. `GET /v2/oi?condition=<id[,id]>` returns `{data: [{condition_id, value}]}` in USDC. Polyscout also reads `GET /v2/resolutions?condition=` (UMA status, payouts, `was_disputed`); polytech reads resolution state from Gamma's `umaResolutionStatus` instead.

Comma-separated `condition` lists work on all three v2 routes (verified live), which is what polytech's sweep relies on (chunks of 20 to 50 conditions per call).

Rate limits: polytech budgets 200 / 10 s (`/trades` documented limit); polyscout 4 req/s burst 8. The Data API sits behind Cloudflare too and has answered sweeps with 403; polytech treats a failed enrichment chunk as soft (books still land).

## CLOB WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`): live books

Polyscout's `ws.ts` is the reference client; polytech had none. Protocol, as captured live:

- After connect, send `{"type":"market","assets_ids":[...token ids...],"custom_feature_enabled":true}`. Later changes: `{"operation":"subscribe"|"unsubscribe","assets_ids":[...]}`.
- The server sends `"PING"` → `"PONG"` as bare text; clients must send `PING` about every 10 s or get dropped. A connection that goes silent for 30 s is treated as dead.
- First frame per subscription is a JSON **array** of `book` snapshots (`event_type: "book"`, same fields as REST `/book` plus `hash`), one per asset. Then single-object frames: `price_change` (`{market, timestamp (ms), price_changes: [{asset_id, price, size, side: BUY|SELL, hash, best_bid, best_ask}]}` where `size` is the new total resting at `price` on that side, `0` removes the level, BUY = bid side), `last_trade_price` (`{asset_id, market, price, size, side, fee_rate_bps, timestamp, transaction_hash}`), `tick_size_change` (`{old_tick_size, new_tick_size}`), and with custom features `best_bid_ask`, `new_market`, `market_resolved` (`{assets_ids, winning_asset_id, winning_outcome}`). Numbers are strings everywhere; the server pretty-prints with spaces.
- Reconnect with exponential backoff and jitter (1 s → 30 s), re-send the current asset set on every reconnect: each reconnect starts with fresh snapshots, so deltas received before a snapshot for a token are meaningless and must be dropped.

## Cross-cutting: rate limiting, retries, validation, fixtures

| Concern | polyscout | polytech before | polytech now |
|---|---|---|---|
| Throttle | class `TokenBucket` per host, FIFO via chained promise, `penalize()` on 429 | per-host deficit bucket (`bucket(limit, windowMs)`), callers queue by sleep length, no 429 feedback | FIFO bucket with `penalize(ms)`: a 429 drains the host bucket and makes the whole queue sit out Retry-After (≥ 5 s, ≤ 30 s); burst capped at 1/5 of the window so fan-outs are paced |
| Retries | 3, backoff 500 ms doubling with jitter, Retry-After (seconds or HTTP-date) as lower bound | 3, backoff 250 ms doubling, Retry-After seconds, 429 floor 5 s | same as before plus HTTP-date Retry-After, penalty shared across callers |
| Error type | `HttpError {status,url,body}`, `ParseError` | `Error("GET /path -> 429 body")` string contract (callers regex on it) | unchanged (string contract kept, `-> 404` mapped to `undefined` where "none" is a valid answer) |
| Validation | tolerant `z.looseObject` + `looseNumber/looseString/looseBool/stringList/numberList`; `ParseError` only on hard shape breaks | tolerant `z.looseObject` + `num/str/bool/arr/list`, bad rows dropped, never throws | same, plus `toIso` for both Gamma date spellings, fee schedule, outcomes/prices arrays, v1 + v2 Data API spellings |
| Data API | v2 | v1 (retiring 2026-10-24) | v2, cursor paging, `since`, `takerOnly` |
| Prices history | typed `interval` xor `startTs/endTs` | untyped, unused | typed `HistoryQuery`, seconds in/out |
| CLOB market info | `clobMarketInfo()` with `feeDetails` | none | `clobMarket()` with `fee_schedule` |
| WebSocket | `subscribeMarket` + `parseWsMessage` | none | `@pm/pm/ws`: `subscribeMarket`, `subscribeBooks`, `bookStore`, `applyPriceChange`, `parseWsMessage` |
| Fixtures | recorded live responses, replayed through a mocked `fetch` in contract tests (bun:test) | generated deterministic universe served by `PM_FIXTURES=1` (`fixtures.ts`) | both: the generated universe for app tests, polyscout's recordings in `fixtures/contract/` for vitest contract tests |

## What polytech adopted (this change)

All in `packages/pm`; the public API of `createPm()` is a superset of the previous one and every existing caller (`apps/web/lib/jobs/*`, `apps/web/lib/feed.ts`, hooks) compiles unchanged.

1. `bucket.ts`: FIFO-fair token bucket with `penalize(ms)`, injectable `now`/`sleep`, optional `burst`. `createPm` wires a 429 into `penalize(max(5 s, Retry-After) ≤ 30 s)` so parallel chunks on the same host stop hammering together. Retry-After accepts seconds or an HTTP-date. Unit tests in `bucket.test.ts`.
2. `schemas.ts`: `toIso` handles both Gamma timestamp spellings; `Market` gains `outcomes`, `outcome_prices`, `spread`, `start_date`, `closed_time`, `neg_risk_augmented`, `fee_bps`, `fee_schedule`, `fees_enabled`, `fee_type`; `PmEvent` gains `active`, `closed`, `liquidity`, `volume`, `volume_24h`, `open_interest`; `Book` gains `hash`, `last_trade_price`; `Trade` gains `outcome`, `outcome_index`; holders gain `outcome_index`, `name`. New `takerFee()`, `sortLevels()`, `normClobMarket()`, `ClobMarketInfo`, `FeeSchedule`. Data API normalisers accept v1 and v2 spellings.
3. `index.ts`: Data API moved to `/v2/*` with `condition=`; `trades()` pages by cursor with `since`/`takerOnly` and repeats the selectors on each page; `holders()` returns the amounts needed for HHI / top-N; `pricesHistory()` takes a typed `HistoryQuery`; new `book()`, `clobMarket()`; `listEvents()` accepts `tagId`, `tagSlug`, `liquidityMin`. `feeRateBps()` is kept and marked legacy.
4. `ws.ts`, exported as `@pm/pm/ws` (browser-safe: zod + `./schemas` only; the package root pulls `node:fs` through the fixture server). `subscribeMarket(assetIds, {onEvent, ...})` reconnects with backoff + jitter, re-subscribes, pings every 10 s, drops stale sockets, `close()` is final. `bookStore()` folds `book` snapshots and `price_change` deltas into best-first `Book`s and ignores deltas without a snapshot; `subscribeBooks()` glues the two for the `/trade` terminal. Fake-socket tests in `ws.test.ts`.
5. `fixtures.ts`: serves the v2 Data API paths, `GET /book` and `GET /clob-markets/{id}` from the generated universe.
6. `contract.test.ts` + `fixtures/contract/*.json`: polyscout's recordings (Gamma pages, resolved markets, CLOB book/books/midpoints/history/market-info, Data v2 holders/trades/oi, WS frames) replayed through `createPm` with a mocked fetch.

Not adopted: polyscout's `HttpError`/`ParseError` classes (polytech's string error contract is what `sweep.ts` and `keyset()` pattern-match on), its global per-host bucket registry (polytech keeps buckets per `createPm` instance so tests and jobs do not share state), its single-token `GET /midpoint|/spread|/last-trade-price` (polytech batches), `GET /tags`, `GET /v2/resolutions` (Gamma `umaResolutionStatus` already feeds the dispute flag), and backoff jitter (polytech's retry tests assert exact waits; the WebSocket reconnect does jitter).

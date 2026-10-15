# Polymarket API facts (research, L0)

Date of research: 2026-10-15.

## Access and method (read first)

- `docs.polymarket.com` and `help.polymarket.com` are NOT reachable from this machine. WebFetch fails with a TLS error: `Hostname/IP does not match certificate's altnames ... DNS:*.juegoilegal.es`. A cert for another domain is served for the Polymarket host, which looks like ISP interception. curl fails the same way. Not bypassed.
- Official content below was therefore obtained through (a) WebSearch summaries that quote the official docs, (b) official GitHub repos fetched via raw.githubusercontent.com / github.com, (c) npm metadata via `pnpm view`, and (d) third-party guides (labelled).
- Verification labels used:
  - `[SRC]` read in official Polymarket source code or repo file (possibly archived).
  - `[SNIP]` seen only in WebSearch summary of an official docs page. Not opened directly.
  - `[3P]` third-party guide, blog, or community repo.
  - `UNVERIFIED` no reliable source, or sources conflict.
- Hosts:
  - Gamma: `https://gamma-api.polymarket.com` [SRC] (agents repo)
  - CLOB: `https://clob.polymarket.com` [SRC] (clob-client)
  - Data API: `https://data-api.polymarket.com` [3P] (geenes guide, and official host name per search summaries)
  - Goldsky subgraph (GraphQL): `https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn` [SRC] (agent-skills file). Not needed by the requested list.

## 0. Official SDK packages (npm, checked 2026-10-15)

| Package | latest | Status | Verdict |
|---|---|---|---|
| `@polymarket/client` | 0.13.0 | Official TS SDK, repo `github.com/Polymarket/ts-sdk`, maintainers @polymarket.com. dist-tags: latest 0.13.0, beta 0.3.0-beta.1 | Use for markets listing and neg-risk ops. Pre-1.0: "minor releases on the 0.x line may include breaking changes." README documents only `createPublicClient()` and `client.listMarkets({ closed, pageSize })` (async iterable of pages, `page.items: Market[]`), plus neg-risk ops (`setupTradingApprovals`, `horizontalSplit`, `horizontalMerge`, `convert`). README does NOT document order books, prices, price history, fee rate, or tick size. [SRC] |
| `@polymarket/clob-client` | 5.8.1 | Official, but repo README says: "The client is no longer functional and should not be used for new or existing integrations." Not deprecated on npm. | Do not use. Use it only as an endpoint reference. [SRC] |
| `@polymarket/order-utils` | 3.0.1 | Order creation/signing utility | Out of L0 scope. Maintainers @polymarket.com. |
| `@polymarket/real-time-data-client` | 1.4.0 | WebSocket client | Out of L0 scope. |

Recommendation: raw `fetch` against the endpoints in sections 1 to 4, plus `@polymarket/client` for Gamma market listing if you want an SDK. The CLOB and Data API have no documented SDK methods in the current official client.

Note: the npm README for `@polymarket/client` returned empty from `pnpm view`. The README text above came from the GitHub repo fetch, not npm.

## 1. Gamma API (`https://gamma-api.polymarket.com`)

No auth for reads. Method GET.

### 1a. Markets list

Two routes exist:

| Route | Pagination | Notes |
|---|---|---|
| `GET /markets` | offset (`limit`, `offset`) | Offset appears capped. Reported 200 at offset=2000, HTTP 422 at offset=2050 with body `{"type":"validation error","error":"offset too large, use /markets/keyset for deeper pagination"}` [3P: py-sdk issue #127 report] |
| `GET /markets/keyset` | cursor (`after_cursor` in, `next_cursor` out) | Recommended for deep pagination. Reported bug: passing `cursor` returns the same first page. Maintainer (desfero, 2026-07-06) said the correct param is `after_cursor`. [3P issue thread, maintainer reply quoted] |

Query params:

| Param | Type | Route | Notes |
|---|---|---|---|
| `limit` | int | both | Max unclear: one source says 1–100 (default 20), another says Gamma caps pages at 100 rows. UNVERIFIED |
| `offset` | int | `/markets` | Ceiling as above |
| `after_cursor` | string | `/markets/keyset` | Value from previous `next_cursor` [SRC maintainer reply; 3P issue] |
| `closed` | bool | both | `closed=false` used to list open markets [SNIP official discover-markets] |
| `active` | bool | `/markets` | [SRC agents/gamma.py] |
| `archived` | bool | `/markets` | [SRC agents/gamma.py] |
| `order` | string | `/markets` | UNVERIFIED for `/markets` (documented for `/events`) |
| `ascending` | bool | `/markets` | UNVERIFIED for `/markets` |
| `enableOrderBook` | bool | `/markets` | [SRC agents/gamma.py `get_clob_tradable_markets`] |
| `slug` | string | `/markets` | Filter by slug [SRC polymarket agent-skills market-data.md] |
| `id` / `conditionId` filter | — | `/markets` | UNVERIFIED |

Response envelope:
- `/markets` [3P]: `"markets"` array? UNVERIFIED. Some sources treat the response as a bare JSON array.
- `/markets/keyset` [3P issue #227]: object with `markets` (array) and `next_cursor` (string). `next_cursor` is present only when the page is full [SNIP official events keyset doc]. Cursor payload is opaque base64-like (decoded fields `v`, `k`, `oh`, `keys`).

Example market (third-party, OddsPapi blog captured 2026-10-15; trimmed; IDs truncated by source) [3P]:

```json
{
  "id": "4329891",
  "question": "Chargers vs. Chiefs",
  "conditionId": "0xa70da744...b546",
  "slug": "nfl-lac-kc-2026-10-18",
  "outcomes": "[\"Chargers\", \"Chiefs\"]",
  "outcomePrices": "[\"0.215\", \"0.785\"]",
  "clobTokenIds": "[\"25975...\", \"58167...\"]",
  "volume": "3512.5369280000004",
  "liquidity": "149784.2895",
  "lastTradePrice": 0.21,
  "bestBid": 0.21,
  "bestAsk": 0.22,
  "spread": 0.01,
  "negRisk": false,
  "active": true,
  "closed": false,
  "orderPriceMinTickSize": 0.01,
  "orderMinSize": 5
}
```

Type notes:
- `outcomes`, `outcomePrices`, `clobTokenIds` are STRINGS containing JSON arrays. Must `JSON.parse` them. [SRC: agents/gamma.py does `json.loads` on `outcomePrices` and `clobTokenIds`.] `outcomes` as a string array is [3P] only.
- `volume` and `liquidity` appear as strings in the 3P example. The official SDK model (below) declares them `float`. CONFLICT. Treat as `string | number` and validate at runtime. UNVERIFIED which is correct live.
- `outcomePrices` is the mid price per outcome (3P article: "outcomePrices is the midpoint"). `bestBid`/`bestAsk` apply to the first outcome only [3P].

Market field list, official SDK model (`Polymarket/agents`, `agents/utils/objects.py`) [SRC]. The SDK model is a Python pydantic model in an official repo, not the live API response. Fields and declared types:

```
id: int
question: str?           conditionId: str?      slug: str?
resolutionSource: str?   endDate: str?          startDate: str?
liquidity: float?        volume: float?         outcome: list?   (singular, see note)
outcomePrices: list?     clobTokenIds: list?    active: bool?    closed: bool?
description: str?        image/icon: str?       createdAt/updatedAt: str?
volume24hr: float?       volumeNum/liquidityNum: float?
endDateIso/startDateIso: str?
enableOrderBook: bool?   orderPriceMinTickSize: float?  orderMinSize: int?
acceptingOrders: bool?   negRisk: bool?         commentCount: int?
groupItemTitle: str?     groupItemThreshold: int?       questionID: str?
umaBond: int?            umaReward: int?
volume24hrClob / volumeClob / liquidityClob: float?
clobRewards: list[ClobReward]?   rewardsMinSize: int?  rewardsMaxSpread: float?  spread: float?
events: list[PolymarketEvent]?
deployed / funded / ready / cyom / competitive / approved / featured / restricted / archived / new: misc?
```

Notes on that list:
- `outcome` (singular list) in the SDK model vs `outcomes` (JSON string) in the live-looking example. CONFLICT. Trust the live JSON; UNVERIFIED for the official live field name.
- `negRiskMarketID` is NOT in the SDK model. `umaResolutionStatus` is NOT in the SDK model. Both UNVERIFIED for Gamma market objects.
- `description` is present. `rules` as a separate field is UNVERIFIED.
- `tags` is NOT on Market; it is on the event (see 1b).
- `negRisk` is on the market [SRC model + 3P example].

### 1b. Events list

| Route | Pagination |
|---|---|
| `GET /events` | offset (`limit`, `offset`) |
| `GET /events/keyset` | cursor (`after_cursor`, `next_cursor`) [SNIP official docs: "`offset` is explicitly rejected" on keyset] |

Query params [3P: geenes/polymarket-cli, and SRC for `active`, `closed`, `limit`, `slug`, `tag_id`, `series_id`, `order`, `ascending` via agent-skills]:

| Param | Type | Default | Values |
|---|---|---|---|
| `limit` | int | 20 | 1–500 [3P] |
| `offset` | int | — | offset route only |
| `after_cursor` | string | — | keyset route only |
| `active` | bool | — | |
| `closed` | bool | — | e.g. `closed=false&limit=20` [SNIP] |
| `order` | string | — | `volume_24hr`, `volume`, `liquidity`, `start_date`, `end_date`, `competitive`, `closed_time` [3P] |
| `ascending` | bool | false | |
| `tag_id` | int | — | e.g. `100381` [SRC agent-skills] |
| `series_id` | int | — | e.g. `10345` [SRC agent-skills] |
| `slug` | string | — | |

Event fields, official SDK model [SRC `agents/utils/objects.py`]:

```
id: str         ticker: str?        slug: str?         title: str?
startDate/endDate/creationDate: str?   image/icon: str?
active/closed/archived/new/featured/restricted: bool?
liquidity/volume/volume24hr/competitive: float?
enableOrderBook: bool?   liquidityClob: float?   commentCount: int?
markets: list[Market]?   tags: list[Tag]?
cyom/showAllOutcomes/showMarketImages: bool?
```

Tag (SRC model): `id: str`, `label: str?`, `slug: str?`, `forceShow: bool?`, `createdAt/updatedAt: str?`.

Event example JSON: NOT obtained with a real response. Use the field list above. UNVERIFIED for live values.

Category: from `tags` on the event. `category` as a dedicated field: UNVERIFIED.

### 1c. Market detail

- `GET /markets/{id}` [SRC agents/gamma.py `get_market` uses `gamma_markets_endpoint + "/" + str(market_id)`]. Path param is the numeric market `id`.
- `GET /markets?slug={slug}` [SRC agent-skills market-data.md].
- `GET /markets/slug/{slug}`: UNVERIFIED.
- Response: a single market object (same shape as 1a) [SRC shape from agents model; live shape UNVERIFIED].

### 1d. Neg-risk in Gamma

See section 7.

## 2. Gamma comments

- `GET https://gamma-api.polymarket.com/comments`
- Query params [SNIP official OpenAPI summary, WebSearch]:
  - `parent_entity_type`: `Event`, `Series`, or `market` (note the mixed casing in the summary; UNVERIFIED which casing is required)
  - `parent_entity_id`: integer
  - `limit`, `offset`, `order`, `ascending`, `get_positions` (bool) [SNIP]
- Practical note [3P Glama listing]: both `parent_entity_type` and `parent_entity_id` appear to be needed, otherwise Gamma may return 422. Example from that listing: `parent_entity_type=Event&parent_entity_id=80505`. UNVERIFIED (not live-tested).
- Response: array of comment objects. Field names use camelCase, including `parentEntityType` and `parentEntityID` [SNIP]. Full field list and example JSON: UNVERIFIED.
- Pagination: offset (`limit`/`offset`) [SNIP]. Cursor not reported.

## 3. CLOB API (`https://clob.polymarket.com`)

Path constants [SRC clob-client `src/endpoints.ts`, archived repo, verbatim]:

```
GET /time                 GET /tick-size        GET /neg-risk       GET /fee-rate
GET /book                 GET /books (POST)     GET /midpoint       GET /midpoints (POST)
GET /price                GET /prices (POST)    GET /spread         GET /spreads (POST)
GET /last-trade-price     GET /last-trades-prices (POST)
GET /prices-history       GET /markets          GET /markets/{conditionId}
GET /simplified-markets   GET /sampling-markets
```

Methods per the archived SDK source [SRC clob-client `src/client.ts`]:

| Call | HTTP | Input | Returns (per SDK) |
|---|---|---|---|
| `getOrderBook(tokenID)` | GET `/book?token_id=` | `token_id` | `OrderBookSummary`; SDK updates tick-size cache from `asset_id`, `tick_size` |
| `getOrderBooks(params)` | POST `/books` | body `BookParams[]` | `OrderBookSummary[]` |
| `getMidpoint(tokenID)` | GET `/midpoint?token_id=` | `token_id` | `any` |
| `getMidpoints(params)` | POST `/midpoints` | body `BookParams[]` | `any` |
| `getSpread(tokenID)` | GET `/spread?token_id=` | `token_id` | `any` |
| `getSpreads(params)` | POST `/spreads` | body `BookParams[]` | `any` |
| `getLastTradePrice(tokenID)` | GET `/last-trade-price?token_id=` | `token_id` | `any` |
| `getLastTradesPrices(params)` | POST `/last-trades-prices` | body `BookParams[]` | `any` |
| `getPricesHistory(params)` | GET `/prices-history` | query `PriceHistoryFilterParams` | `MarketPrice[]` (type not in provided source) |
| `getTickSize(tokenID)` | GET `/tick-size?token_id=` | `token_id` | `minimum_tick_size` (stringified) |
| `getNegRisk(tokenID)` | GET `/neg-risk?token_id=` | `token_id` | `neg_risk` boolean |
| `getFeeRateBps(tokenID)` | GET `/fee-rate?token_id=` | `token_id` | `base_fee` number |
| `getMarket(conditionID)` | GET `/markets/{conditionID}` | path | raw response (type not declared) |

`BookParams` body element: `{ "token_id": string, "side"?: "BUY" | "SELL" }`. `token_id` usage [SRC py-clob-client `BookParams(token_id=...)`]. `side` optional [SRC SDK type not provided, UNVERIFIED].

Batch limit: 500 tokens per batch POST [SRC agent-skills market-data.md].

### 3a. POST /books

- Body: array of `{ token_id }` (see above).
- Response: array of order book summaries [SRC SDK type `OrderBookSummary[]`]. Example below.

Order book example. ILLUSTRATIVE: built from 3P printed output and SRC field names. Values for `market`, `timestamp`, `hash` are placeholders, not captured data:

```json
{
  "market": "0xa70da744...b546",
  "asset_id": "25975...",
  "timestamp": "1791986416000",
  "bids": [{ "price": "0.78", "size": "39472.87" }],
  "asks": [{ "price": "0.79", "size": "2495.56" }],
  "tick_size": "0.01",
  "min_order_size": "5",
  "neg_risk": false,
  "hash": "..."
}
```

- Field names confirmed: `asset_id`, `tick_size`, `min_order_size`, `neg_risk`, `bids`, `asks`, `price`, `size` [3P prints + SRC]. `market`, `timestamp`, `hash` UNVERIFIED.
- Prices and sizes are STRINGS in the printed 3P output. Treat as strings.
- Both `bids` and `asks` are sorted worst-first; the touch is the last element [3P]. UNVERIFIED against official doc.

### 3b. POST /midpoints, /spreads, /last-trades-prices

- Body: `BookParams[]`.
- Response shape: UNVERIFIED. The SDK returns `any`. Expect a map `token_id -> value` or an array, but not confirmed.
- Single-endpoint shapes:
  - `GET /midpoint?token_id=` → `{ "mid": <value> }` [3P: `mid["mid"]`; string vs number UNVERIFIED].
  - `GET /spread?token_id=` → response key UNVERIFIED (SDK returns `any`; no source shows the key).
  - `GET /last-trade-price?token_id=` → response keys UNVERIFIED (SDK returns `any`; a 3P note suggests `price` and `side`).
  - `GET /price?token_id=&side=BUY|SELL` → `{ "price": <value> }` [3P: `buy["price"]`]. `side=BUY` returns best bid [3P].

### 3c. GET /prices-history

- URL: `https://clob.polymarket.com/prices-history`
- Params [SRC SDK `PriceHistoryFilterParams`, 3P]:
  - `market`: the CLOB TOKEN ID, not the condition ID [3P OddsPapi: "`market` (takes a token ID)"]. CONFLICT: the name suggests condition ID. UNVERIFIED which the live API expects; test both.
  - `interval`: `1m`, `1h`, `6h`, `1d`, `1w`, `max` [3P, polymarket-cli].
  - `fidelity`: bucket size in minutes, e.g. `60` [3P].
  - `startTs` / `endTs`: Unix seconds, mutually exclusive with `interval` [3P].
- Response:

```json
{
  "history": [
    { "t": 1791986416, "p": 0.785 }
  ]
}
```

- `t`: integer Unix seconds. `p`: number, midpoint [3P: `24 points, first {'t': 1791986416, 'p': 0.785}`].

### 3d. Market info and fee rate

- Fee rate: `GET /fee-rate?token_id=<token>` → `{ "base_fee": <number> }` [SRC clob-client `getFeeRateBps`]. The field is in basis points according to the method name `getFeeRateBps` [SRC name only; unit UNVERIFIED].
- Tick size: `GET /tick-size?token_id=<token>` → `{ "minimum_tick_size": "<string>" }` [SRC `getTickSize`].
- Neg-risk flag: `GET /neg-risk?token_id=<token>` → `{ "neg_risk": <bool> }` [SRC `getNegRisk`].
- Market info by condition: `GET /markets/{conditionId}` [SRC `getMarket` uses `GET_MARKET + conditionID`]. Response shape: UNVERIFIED (SDK returns raw `any`). Expect `fee` / `feeSchedule` data here per 3P claims; UNVERIFIED.
- `getClobMarketInfo` does NOT exist in the archived SDK [SRC]. Name appears in a 3P article only. UNVERIFIED as an endpoint.
- Fee rate can change per market and over time [3P]. Read at runtime. Do not hardcode.

## 4. Data API (`https://data-api.polymarket.com`)

All [3P] (geenes/polymarket-data-api-guide, a community guide that says it is not official). Method GET. No auth for reads. Official docs not reachable.

### 4a. Holders

- `GET /holders?market=<cond1,cond2>&limit=&minBalance=`
- `market`: CSV of condition IDs, REQUIRED. `limit`: default 20, max 20 per token. `minBalance`: default 1, max 999999. No offset; no pagination.
- Response: array grouped by outcome token: `[{ "token": "<tokenId>", "holders": [ ... ] }]`. Inner holder fields UNVERIFIED.

### 4b. Open interest

- `GET /oi?market=<cond1,cond2>` (market optional).
- Response: `[{ "market": "<conditionId>", "value": <number> }]`. Types not fully specified in source.
- Keep OI separate from volume [3P].

### 4c. Trades

- `GET /trades`
- Params (all optional) [3P]:

| Name | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 100 | 0–10000 |
| `offset` | int | 0 | 0–10000 |
| `takerOnly` | bool | true | |
| `filterType` | string | — | `CASH` or `TOKENS`, requires `filterAmount` |
| `filterAmount` | number | — | requires `filterType` |
| `market` | CSV | — | condition IDs; not with `eventId` |
| `eventId` | CSV int | — | not with `market` |
| `user` | string | — | wallet address |
| `side` | string | — | `BUY` or `SELL` |
| `start` | int | — | Unix seconds |
| `end` | int | — | Unix seconds |

- Pagination: offset. Stop on a short or empty page [3P].
- Response: `Trade[]`. Fields [3P schema description, not sample JSON]:

```json
{
  "side": "BUY",
  "size": 10.5,
  "price": 0.42,
  "timestamp": 1791986416,
  "asset": "25975...",
  "conditionId": "0x...",
  "transactionHash": "0x...",
  "proxyWallet": "0x..."
}
```

- Types: `size`, `price` numbers; `timestamp` integer seconds; `asset` string (do not coerce to Number) [3P]. Other display fields exist but are not enumerated.

Other Data API routes (not requested): `/positions`, `/closed-positions`, `/activity`, `/value`, `/v1/market-positions`, `/live-volume`, `/traded`, `/v1/leaderboard` and others [3P]. Listed in the source guide only.

## 5. Rate limits, fees

### 5a. Rate limits

Official page `docs.polymarket.com/api-reference/rate-limits` NOT fetched (host blocked). Figures below come from a WebSearch summary that quotes that page [SNIP], plus 3P sources for corroboration.

| Host / route | Limit | Source |
|---|---|---|
| Gamma general | 4000 req / 10 s | [SNIP] |
| Gamma `/markets` | 300 req / 10 s | [SNIP] |
| Gamma `/events` | 500 req / 10 s | [SNIP] |
| Data API general | 1000 req / 10 s | [3P geenes; SNIP] |
| Data API `/trades` | 200 req / 10 s | [3P geenes] |
| Data API `/positions`, `/closed-positions` | 150 req / 10 s each | [3P geenes] |
| CLOB general | 9000 req / 10 s | [SNIP] |
| CLOB `/book`, `/midpoint` (single) | 1500 req / 10 s | [SNIP] |
| CLOB `/books`, `/midpoints` (batch) | 500 req / 10 s | [SNIP] |
| CLOB `/books` (older changelog) | 50 req / 10 s | [3P changelog snippet; likely outdated] |

Behavior [SNIP]:
- Limits are IP-based, enforced by Cloudflare throttling.
- Exceeding a limit queues or delays requests rather than rejecting them.
- Windows are sliding, not fixed.
- Order placement and cancellation use separate per-signer token buckets [SNIP]. Out of L0 scope.

UNVERIFIED: the exact per-endpoint numbers for the CLOB and Gamma routes above. Re-check the live rate-limit page before relying on them. A one-line check: request the page in a browser from an unblocked network.

### 5b. Fee formula

Official help center text, quoted in a WebSearch summary [SNIP]:
- Taker fee: `fee = C × feeRate × p × (1 − p)`, where `C` = shares, `p` = price, `feeRate` = per-market rate.
- Makers pay no fee.
- Peak effective rate at p = 0.5. Fee as a percentage of spend = `feeRate × p × (1 − p)`.
- Per-category rates [SNIP help center, snapshot date unknown]: Crypto `0.07`, Sports `0.05`. Maker rebates: 20% (crypto), 15% (sports).

Conflicting data, UNVERIFIED:
- Exponent variant [3P, several 2026 guides]: `fee = C × p × feeRate × (p × (1 − p))^exponent`, exponent 1 for most categories. Rates in these sources: Crypto `0.072`, Sports `0.03`. Another source lists Economics `0.03` with exponent 0.5. Two sources contradict each other on exponent and rates.
- Sports rate change to 0.05 as of July 2026 [3P] vs older 0.03 on some markets [3P].
- Geopolitics and world-events markets: fee-free [3P].
- Polymarket US: a different schedule (e.g. `0.06 × C × p × (1 − p)` from 2026-07-01, or flat 0.30%) [3P]. Likely not applicable to the global CLOB. UNVERIFIED.
- Fees apply only to markets deployed on or after an activation date [3P].

Practical rule: read fee data per market at runtime from `GET /fee-rate?token_id=` (`base_fee`) and from the market object (`feeSchedule` per 3P). Do not hardcode per-category rates.

## 6. Official TypeScript client (checked on npm)

Summary in section 0. Key points:
- Official, published by Polymarket maintainers on npm: `@polymarket/client` (v0.13.0). Source: `github.com/Polymarket/ts-sdk` (monorepo; the client package is `packages/client`).
- Install: `pnpm add @polymarket/client` [SRC README].
- Verified README methods: `createPublicClient()`, `client.listMarkets({ closed: false, pageSize: 3 })` → async iterable of pages with `items: Market[]`. Neg-risk: `setupTradingApprovals()`, `horizontalSplit({ conditionId, amount })`, `horizontalMerge({ conditionId, amount })`, `convert({ conditionId, amount })`, `prepare*` variants for external signing.
- Not documented in README: order books, prices, price history, fee rate, tick size. Use raw fetch.
- `@polymarket/clob-client` is archived and "no longer functional". Do not use.
- Python `py-clob-client` is also archived per its README [SRC]. Do not use.

## 7. Neg-risk group semantics

Official docs summary [SNIP, `docs.polymarket.com/advanced/neg-risk`]:
- Neg-risk events have a set of mutually exclusive outcomes. Exactly one resolves YES; the others resolve NO [SNIP, ChainSecurity audit summary, 3P].
- Conversion: a NO share in any market can be converted into one YES share in every other market in the group. Done atomically by the Neg Risk Adapter [SNIP].
- Gamma flags [SNIP]: `enableNegRisk` and `negRiskAugmented` on events. `negRisk` boolean on events and markets.
- Augmented neg-risk [SNIP]: placeholder "unnamed" outcomes exist so new candidates can be named later. Trade only named outcomes. If the true outcome is not named at resolution, it resolves to "Other".
- Order placement: pass `negRisk: true` / `neg_risk: true` for both standard and augmented neg-risk markets [SNIP].
- Gamma grouping: not confirmed. `negRiskMarketID` is NOT in the official SDK model [SRC], so the grouping key is UNVERIFIED. Group by `events[].id` (event) as a working assumption, and confirm against a live neg-risk event.
- Per-token: `GET /neg-risk?token_id=` (CLOB) tells whether a token belongs to a neg-risk market [SRC `getNegRisk`].

## 8. Coverage gaps and UNVERIFIED list

- UNVERIFIED: official rate-limit numbers (all). Source: search summary only.
- UNVERIFIED: fee formula constants, exponent, current per-category rates. Sources conflict.
- UNVERIFIED: whether `volume`, `liquidity` are strings or numbers in live Gamma responses.
- UNVERIFIED: `outcome` (SDK) vs `outcomes` (live) field name.
- UNVERIFIED: `negRiskMarketID`, `umaResolutionStatus`, `rules`, `category` on Gamma market objects.
- UNVERIFIED: `/markets` `limit` max (100 vs unbounded); `/markets` offset ceiling exact value.
- UNVERIFIED: `after_cursor` on `/markets/keyset` against the live API (maintainer statement only; reproduced bug in issue #127 closed as user-side, reported in #227 as unresolved).
- UNVERIFIED: full Gamma comment response shape and whether `parent_entity_type` expects `Event` or `event`.
- UNVERIFIED: POST `/midpoints`, `/spreads`, `/last-trades-prices`, `/prices` response shape.
- UNVERIFIED: `GET /spread`, `GET /last-trade-price` exact response keys (from 3P prose, not a live response).
- UNVERIFIED: `market` param on `/prices-history` accepts token ID (3P) vs condition ID.
- UNVERIFIED: `GET /markets/{conditionId}` (CLOB) response shape and whether it carries fee schedule.
- UNVERIFIED: Data API holders inner fields; open-interest field types.
- UNVERIFIED: `feeSchedule` object name and shape on market.
- UNVERIFIED: whether `/fee-rate` `base_fee` is in basis points.
- Not obtained: real Gamma event JSON, real comment JSON, real CLOB POST batch JSON. Fixtures for these must come from a live call from an unblocked network.

## Sources

Official GitHub, fetched:
- https://github.com/Polymarket/agent-skills/blob/main/market-data.md
- https://github.com/Polymarket/polymarket-cli/blob/main/README.md
- https://github.com/Polymarket/py-sdk/issues/127
- https://github.com/Polymarket/agents/issues/227
- https://raw.githubusercontent.com/Polymarket/agents/main/agents/polymarket/gamma.py
- https://raw.githubusercontent.com/Polymarket/agents/main/agents/utils/objects.py
- https://raw.githubusercontent.com/Polymarket/clob-client/main/src/endpoints.ts (archived)
- https://raw.githubusercontent.com/Polymarket/clob-client/main/src/client.ts (archived)
- https://github.com/Polymarket/clob-client (README, archived)
- https://github.com/Polymarket/py-clob-client (README, archived)
- https://github.com/Polymarket/ts-sdk (root README)
- https://github.com/Polymarket/ts-sdk/tree/main/packages/client
- https://raw.githubusercontent.com/Polymarket/ts-sdk/main/packages/client/README.md

Third-party, fetched:
- https://github.com/geenes/polymarket-data-api-guide (Data API; community)
- https://oddspapi.io/blog/?p=2833 (Gamma and CLOB examples; community)

Search summaries only (official pages not opened):
- https://docs.polymarket.com/api-reference/rate-limits
- https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination
- https://docs.polymarket.com/advanced/neg-risk
- https://docs.polymarket.com/api-reference/comments/list-comments
- https://help.polymarket.com/en/articles/13364478-trading-fees (fetch failed: TLS mismatch)

npm (via `pnpm view`): `@polymarket/client`, `@polymarket/clob-client`, `@polymarket/order-utils`, `@polymarket/real-time-data-client`.

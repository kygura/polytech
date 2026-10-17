# Polymarket execution stack (research, L0)

Date of research: 2026-10-17. Scope: Phase 6 live order placement (L2, approve-each). Read after `docs/research/polymarket.md`, which covers the read-side APIs.

## Access and labels

`docs.polymarket.com` and `help.polymarket.com` still fail TLS from this machine. The served certificate is for `*.juegoilegal.es`. That matches a Spanish ISP-level block (see section 7), so this is not a bug to route around. Everything below was gathered from GitHub raw files, npm registry JSON, third-party mirrors, and WebSearch summaries that quote official pages.

Labels used per fact:

- `[V]` read directly in a primary source fetched in this session (GitHub, npm, MDN, core.telegram.org, ntfy docs).
- `[S]` WebSearch summary that quotes an official Polymarket docs page. Primary page not opened.
- `[3P]` third-party repo, blog, or cheatsheet.
- `[U]` unverified. Could not confirm.

## Bottom line

1. The package situation is a moving target. `@polymarket/clob-client` (V1) is archived. `@polymarket/clob-client-v2` is marked deprecated on npm and points to the unified SDK. The unified SDK is `@polymarket/client` (0.13.0 on the `latest` tag). Its README does not document order placement. The migration guide, which I could only see through a search summary, says trading lives on a "SecureClient" and is `placeOrder`. Confirm the exact API from `node_modules` types before writing code.
2. Two blockers are open and need a live check from an unblocked network: the deposit-wallet API-key bug (section 2), and geoblocking of the execution host (section 7).
3. Signing is simple enough to do with viem if the SDK path fails. Order struct field names are still `[3P]`.

## 1. Packages and status

- `@polymarket/client` `latest` = 0.13.0, `beta` = 0.3.0-beta.1, `latestnpm` = 0.4.0. Description: "The Polymarket SDK TypeScript client." [V] https://registry.npmjs.org/@polymarket/client
- Repo `https://github.com/Polymarket/ts-sdk`. Packages: `packages/client` (official client), `packages/types`, `packages/bindings` (internal, "not intended for direct usage"). Semver: 0.x minors may break. [V] https://github.com/Polymarket/ts-sdk and https://raw.githubusercontent.com/Polymarket/ts-sdk/main/packages/client/README.md
- The client README documents only `createPublicClient`, `listMarkets`, and neg-risk operations (`setupTradingApprovals`, `horizontalSplit`, `horizontalMerge`, `convert`, and `prepare*` variants). It does not document orders, cancels, balances, or auth. [V] same README
- The README does describe "Neg-risk positions (protocol V2)" and a V2 neg-risk `conditionId`. [V]
- Migration guide (`https://docs.polymarket.com/migrate/clob-sdk-to-unified-sdk`). Search summary says: remove the old CLOB, relayer, and builder-signing packages; install `@polymarket/client` plus a wallet library; `createSecureClient` derives or creates CLOB credentials and configures the signing flow; `placeOrder` runs on it; tick size and negRisk are resolved automatically; upgrade guide asks for 0.12.0 or later. [S] https://docs.polymarket.com/getting-started/migrate-from-previous-sdks and https://docs.polymarket.com/migrate/clob-sdk-to-unified-sdk (search result link only)
- `@polymarket/clob-client-v2`: npm `latest` = 1.2.0, canary 1.1.1-canary.0. Every visible version carries `deprecated`: "This package is deprecated. Please migrate to the unified Polymarket SDK." [V] https://registry.npmjs.org/@polymarket/clob-client-v2 . Its GitHub README repeats this and links the migration guide. [V] https://raw.githubusercontent.com/Polymarket/clob-client-v2/main/README.md . The README documents the full order flow (below), so it is the only official-ish TS path I could read end to end.
- `@polymarket/clob-client` (V1): `latest` = 5.8.1, `beta` = 5.1.3-beta.0. The GitHub README says "no longer functional." Do not use. [V] https://registry.npmjs.org/@polymarket/clob-client and https://github.com/Polymarket/clob-client (from the prior note)
- `web-push` (npm): `latest` = 3.6.7, repo `web-push-libs/web-push`. [V] https://registry.npmjs.org/web-push

Recommendation for Phase 6: use `@polymarket/client@0.13.0` (or whatever `latest` is at implementation time). Before writing any order code, `pnpm add` it in a scratch dir and read the `.d.ts` for `createSecureClient`, `placeOrder`, cancel, and balance methods. If it lacks them, fall back to `@polymarket/clob-client-v2@1.2.0`, which is deprecated but documented, or to raw REST with viem signing (section 3).

## 2. Auth

### L1 (wallet signature, derive API credentials) [V for the agent-skills copy, which is V1-era]

Source: https://raw.githubusercontent.com/Polymarket/agent-skills/main/authentication.md (official Polymarket repo, pre-V2 wording).

- EIP-712 domain: `name: "ClobAuthDomain"`, `version: "1"`, `chainId: 137`.
- Type `ClobAuth`: `address` (address), `timestamp` (string, server time), `nonce` (uint256), `message` (string).
- Message value: `"This message attests that I control the given wallet"`.
- L1 headers: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_NONCE` (default 0).
- The V2 migration summary says the API auth domain version stays `"1"`; only the exchange domain moves to `"2"`. [S] https://docs.polymarket.com/v2-migration (search summary)

The derive call in the V2 client is `createOrDeriveApiKey()`. The README returns `{ key, secret, passphrase }`. [V] https://raw.githubusercontent.com/Polymarket/clob-client-v2/main/README.md

### L2 (HMAC)

- Headers, all five required: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`. Required for `/v1/trade/*` and for cancel endpoints. [V] authentication.md above.
- HMAC signing-string format (timestamp + method + path + body), base64 secret decoding, and output encoding: `[U]` not stated on any page I could read. Read it from the SDK source (`clob-client-v2` `src/`) rather than guessing. The GitHub API listing was blocked, so I could not fetch the file tree.
- Keep `secret` server-side only. [S] https://docs.polymarket.com/market-data/websocket/user-channel (search summary)

### Open bug affecting auth on deposit wallets

GitHub issue #65 on `Polymarket/clob-client-v2`, status Open. For `signatureType` 3 (POLY_1271), L1 auth is signed by the EOA only, so the API key binds to the EOA. Orders then fail with HTTP 400 "the order signer address has to be the address of the API KEY." Reports through Aug 2026 say types 0, 2, and 3 all fail on 1.0.6 and that the TS, Python, and Rust SDKs are affected. No maintainer fix or ETA appears in the thread. [V] https://github.com/Polymarket/clob-client-v2/issues/65

This is the single biggest technical risk. It must be tested live before Phase 6 is scoped.

## 3. Order shape

### Contracts (Polygon mainnet, chainId 137)

- CTF Exchange V2: `0xE111180000d2663C0091e4f400237545B87B996B` [V] https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2 (README-level, via fetch) and [S] https://docs.polymarket.com/resources/contracts
- Neg Risk CTF Exchange V2: `0xe2222d279d744050d28e00520010520000310F59` [V and S, same sources]
- pUSD (V2 collateral, proxy): `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` [V] https://substreams.dev/packages/polymarket/v0.3.0 and [S] docs contracts page
- USDC.e (CTF collateral): `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` [V] same
- Conditional Tokens: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` [V] same
- Neg Risk Adapter: V1 address `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` [3P, agent-skills, V1-era]. V2 address not found. `[U]`
- V1 (legacy, do not sign): CTF Exchange `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`, Neg Risk Exchange `0xC5d563A36AE78145C45a50134d48A1215220f80a`. [V] substreams page

### EIP-712

- Exchange domain: `name: "Polymarket CTF Exchange"`, `version: "2"`, `chainId: 137`, `verifyingContract` = V2 exchange (or neg-risk V2 exchange). [S] https://docs.polymarket.com/v2-migration (search summary)
- Order struct, per third-party cheatsheet `[3P]`: `salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side` (0 BUY, 1 SELL), `signatureType`, `timestamp` (ms, replaces the V1 nonce), `metadata` (bytes32), `builder` (bytes32). The cheatsheet says `nonce`, `expiration`, `taker`, `feeRateBps` are removed from the signed order. The migration summary confirms `nonce`, `feeRateBps`, `taker` are replaced and that fees are set by the operator at match time. `[S]` for the removals, `[3P]` for the exact field list. https://github.com/cengizmandros/polymarket-cheatsheet and https://www.mintlify.com/Polymarket/ctf-exchange/concepts/order-structure (mirror)
- Verify the field list against `src/exchange/libraries/Structs.sol` in `Polymarket/ctf-exchange-v2`. The README there confirms `builder` and `metadata` exist, but the struct body was not in the fetched page. `[U]` for field order and types.
- Signature types: `0` EOA, `1` POLY_PROXY (Magic/email), `2` GNOSIS_SAFE, `3` POLY_1271 (EIP-1271 smart-contract wallet, V2/V3 orders only). [V] for the Rust SDK table: https://github.com/Polymarket/rs-clob-client-v2 . [V] for 0 to 2 in the agent-skills table.
- For a deposit wallet (type 3), `funder` is the deposit wallet and both `maker` and `signer` must be the deposit wallet address. The order signature is an ERC-7739-wrapped POLY_1271 signature, which is longer than a plain ECDSA signature. [S] docs deposit-wallets summary via WebSearch; primary page not opened.
- Deposit wallets are described as the recommended path for new API users. They are deployed through the relayer (WALLET-CREATE, no user signature). [S] https://docs.polymarket.com/trading/deposit-wallets (search link). Caveat: a migration page describes production rollout as "a future Monday," so check current status before relying on it. `[U]`.

### Order fields (client level, per the V2 README)

- `tokenID` (or `positionID` for position-backed outcomes), `price`, `side` (`Side.BUY`/`Side.SELL`), `size` (limit), or `amount` (market, USDC).
- `options`: `{ tickSize: "0.01" }`. Price must match the market's tick size or it is rejected. `negRisk` is passed per market in the older docs; the unified SDK resolves tick size and negRisk automatically. `[V]` README for V2, `[S]` for unified SDK.
- `orderType`: `OrderType.GTC`, `GTD`, `FOK`, `FAK`. Post-only is GTC/GTD only and is rejected if it would cross the spread. `[S]` agent-skills order types (repo is official Polymarket, V1-era wording).
- GTD expiration: UTC seconds. Minimum is `now + 60 + N`, where 60 s is a security buffer. Example `Math.floor(Date.now()/1000) + 60 + 3600`. `[V]` agent-skills order-patterns.md. Whether `expiration` still exists on the signed V2 order is `[U]` (cheatsheet says removed).
- Market orders: FOK and FAK. For BUY the amount is dollars to spend; for SELL it is shares. `[V]` agent-skills
- Limit: GTC/GTD only for post-only. Min order size comes from the market object (`orderMinSize`, per prior note).

### Post and batch endpoints

- Single: `client.createAndPostOrder(...)` (one call) or `createOrder` then `postOrder(signedOrder, OrderType.GTC)` (two calls). `[V]` the V2 README for the one-call; two-call from agent-skills order-patterns. REST path is `POST /order` `[S]` from the rate-limit page. Exact batch path name: `[U]`.
- Batch: `client.postOrders(orders)`, up to 15 orders per request. `[V]` agent-skills order-patterns.md. That page is V1-era; the limit may have changed for V2 `[U]`.
- `GET /time`, `/tick-size`, `/neg-risk`, `/fee-rate` (from prior note) are the metadata reads; the V2 README uses `getVersion()` and `getClobMarketInfo(conditionID)` as warm-up calls. `[V]`

### Hosts

- Production CLOB: `https://clob.polymarket.com` per the migration summary `[S]`. The Rust README uses `https://clob-v2.polymarket.com` as its host `[V]`. Confirm which host the V2 endpoints answer on from the unblocked network. `[U]`.
- WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/user` `[S]`.

## 4. Cancel, reads, fills, status

- Cancel one: `client.cancelOrder("0x...")`. Cancel many: `client.cancelOrders([...])`. Cancel all: `client.cancelAll()`. Cancel by market: `client.cancelMarketOrders({ market: "<conditionId>" })`. All cancel endpoints need L2 auth. `[V]` agent-skills order-patterns.md (V1-era method names; verify in V2 SDK `d.ts`).
- Open orders: `client.getOpenOrders()`, with optional `asset_id` filter. `[S]` docs quickstart summary.
- Trades: `client.getTrades()`, with optional `asset_id` filter. `[S]`
- Order status values: order events carry `status` (sample `LIVE`) and `type` (`PLACEMENT`, `UPDATE`, `CANCELLATION`). `[S]` user-channel summary. The full order-status enum is `[U]`.
- Trade statuses: `MATCHED`, `MINED`, `CONFIRMED`, `RETRYING`, `FAILED`. Source is a Chinese-language mirror of the docs plus a third-party OCaml client, so `[3P]`. Treat `MATCHED` as "filled for our purposes" and `CONFIRMED` as final. Do not treat `FAILED` as a fill.
- User WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/user`. Subscribe with `{ "auth": { "apiKey", "secret", "passphrase" }, "type": "user", "markets": [conditionId...] }` (markets optional). Send right after connect; the server may drop an unsubscribed connection. Text-frame `PING` every 10 s, server replies `PONG`. `[S]` user-channel summary. Keep credentials server-side.
- Use the WebSocket as the primary fill signal, with REST `getTrades` as the reconciliation source on restart.

## 5. Balance and positions for reconciliation

- CLOB collateral: `GET /balance-allowance?asset_type=COLLATERAL` for the pUSD balance and exchange approval. For deposit wallets add `signature_type=3`. `[3P]` cheatsheet, `[S]` deposit-wallets summary. Some sources still call the collateral "USDC"; in V2 it is pUSD `[S]`.
- Refresh the CLOB balance cache after funding or approving. The update call needs `signature_type=3` for deposit wallets. Exact endpoint name `[U]` (not found on any page I could read).
- Data API positions: `GET https://data-api.polymarket.com/positions?user=<address>` `[3P]` (prior note). Not verified against an official page this session.
- On-chain fallback (standard interfaces, not fetched): pUSD `balanceOf(wallet)` (ERC-20) and CTF `balanceOf(wallet, positionId)` (ERC-1155) on Polygon. Use this to detect drift between CLOB cache and chain. `[U]` for the call details here, but the interfaces are standard.

## 6. Approvals (one-time, before first trade)

- Deposit wallet path: approvals are an ordered WALLET batch, signed by the owner signer, sent through the relayer. Use `@polymarket/builder-relayer-client` or the raw relayer API. Then refresh the CLOB balance cache with `signature_type=3`. `[S]` deposit-wallets summary.
- EOA path: pUSD (or USDC.e) `approve` to the exchanges, and CTF `setApprovalForAll` for the exchanges. `[S]` docs summary ("approval is typically handled through the Polymarket UI on your first trade, or by calling `setApprovalForAll()` on the CTF contract"). The exact spender list for V2 is `[U]`.
- Unified SDK: `setupTradingApprovals()` sets pUSD spending approval and PositionManager operator approval, for neg-risk Router use. `[V]` README. Use it as the preferred one-time script if the SDK is adopted, and verify the spenders on-chain afterwards.
- Do not rely on automatic approval. The split, convert, and merge calls in the unified SDK do not approve. `[V]`

## 7. Rate limits and geoblock

### Rate limits (POST /order)

Sources disagree:

- Main API reference: 3,500 req / 10 s burst, 36,000 req / 10 min sustained for `POST /order`. `[S]`
- Quickstart rate-limit page: 500 req / 10 s, and 3,000 req / 10 min. `[S]`
- Chinese-language mirror: 5,000 req / 10 s, 120,000 req / 10 min. `[S]`
- Newer model: per-signer token buckets, one bucket for orders and one for cancels. Each `POST /order` costs one token. Warning mode from 2026-07-24 adds `Poly-RateLimit-Warning: true` instead of rejecting. Whether enforcement is now live is `[U]`. `[S]` https://docs.polymarket.com/api-reference/trading-rate-limits
- Over limit: requests are throttled (queued or delayed), not immediately rejected. `[S]` https://docs.polymarket.com/api-reference/rate-limits

For a single-user engine, this is not the constraint. Keep order submits well under 1/s and log `Poly-RateLimit-Warning`.

### Geoblock

- Endpoint: a GET to the polymarket.com domain (not the API hosts) returns `blocked` (bool), `ip`, `country` (ISO alpha-2), `region`. Exact URL is `[U]` (search summary says polymarket.com; docs path `https://docs.polymarket.com/api-reference/geoblock`). `[S]`
- Blocked lists conflict:
  - API geoblock page: US, Venezuela, Yemen, Zimbabwe fully blocked; Ontario, Crimea, Donetsk, Luhansk restricted. `[S]`
  - FAQ: 33 blocked countries, including UK, France, Germany, Italy, Australia, Russia. `[S]` https://docs.polymarket.com/polymarket-learn/FAQ/geoblocking
  - News (July 2026): Alberta, British Columbia, Quebec added in Canada. Cointelegraph says more than 34 countries blocked, latest Spain. `[3P]`
- Practical rule: the check runs on the request origin. Order submits from a blocked region are rejected. Run the geoblock check at boot and before each order, and fail closed. Also check which region the execution host runs in. A US-region serverless function would hit the US block.

### Spain block (explains the local ISP behavior)

Spain's Ministry of Consumer Rights ordered ISP-level blocks of Polymarket and Kalshi on 2026-05-26, pending licence review, expected to last three to four months. This is `[3P]` only (mirror and aggregator pages; Reuters and El Pais not fetched). The current status as of October 2026 is `[U]`. This is consistent with the TLS interception on this machine. It means the user's own machine cannot reach the APIs, and the execution host must sit outside a blocked jurisdiction. Whether this is acceptable is a product and legal decision for the user, not a technical one.

## 8. Alerts for approve/reject

Requirement: a push to the phone with an approve/reject action that calls back into the Vercel app.

### Option A: ntfy.sh (recommended)

- Publish: `POST https://ntfy.sh/<topic>` with an `X-Actions` header (or JSON). Up to three actions per notification. Types: `view`, `broadcast` (Android only), `http`, `copy`. `[V]` https://docs.ntfy.sh/publish/
- `http` action fields: `action: "http"`, `label`, `url` (required), `method` (default POST), `headers`, `body`, `clear` (clear notification after success). `[V]` same page
- The phone app makes the HTTP request directly. No service worker, no VAPID, no subscription store. The server only needs one publish call and one POST route.
- Security: the approve URL contains a one-time token bound to the pending order id. Topic must be private or self-hosted, because anyone who knows the topic can read the message. `[U]` whether the iOS ntfy app supports `http` actions the same way as Android.
- Code: one publish (`fetch`), one route that verifies the token and state, one state row. Least code of the three.

### Option B: Telegram bot

- Inline keyboard with `callback_data`, limit 1 to 64 bytes. `[3P]` python-telegram-bot docs (the official spec page was truncated in the fetch).
- Webhook: `setWebhook` `secret_token` (1 to 256 chars, sent as `X-Telegram-Bot-Api-Secret-Token`). `[V]` https://core.telegram.org/bots/api
- Must call `answerCallbackQuery` to clear the spinner `[U]` (not confirmed on the official page fetched).
- Code: webhook route, secret check, `from.id` allowlist, callback parsing, `answerCallbackQuery`. More code than ntfy, but works on iOS and Android without a separate app.

### Option C: Web push (VAPID + service worker)

- Needs a service worker, `PushManager.subscribe()`, VAPID keys, a subscription store, and `web-push` (3.6.7). `[V]` MDN Push API page (service worker requirement only; VAPID and iOS details not on that page)
- Action buttons (`Notification.actions`) are limited-availability and not Baseline; no per-browser data was fetched. iOS Safari support for action buttons is `[U]` and must be checked before choosing this path.
- Most code of the three. Reject for this use case.

Recommendation: ntfy.sh with `http` actions. Fallback: Telegram if ntfy's iOS actions prove unreliable.

## 9. Recommended stack

1. Client: `@polymarket/client` pinned to the version tested at implementation time. Confirm `createSecureClient`, `placeOrder`, cancel, open-orders, trades, and balance methods from the `.d.ts` before coding. Fallback: `@polymarket/clob-client-v2@1.2.0` (deprecated, documented), or raw REST plus viem signing.
2. Signing and key custody: private key in an env var, `privateKeyToAccount` from viem, sign in-process (matches the docs examples).
3. Wallet: deposit wallet, signature type 3 (POLY_1271), funder = deposit wallet, maker = signer = deposit wallet. Fallback: EOA type 0. Both are blocked by open issue #65 until proven otherwise on a live account.
4. Collateral pUSD. CTF collateral USDC.e. Use the V2 exchange addresses in section 3.
5. Approvals: one-time script using `setupTradingApprovals` or a relayer WALLET batch, then verify on-chain.
6. Orders: limit only, GTC or GTD (GTD expiration = now + 60 + N s). tickSize from market metadata; negRisk from market.
7. Reconcile: user WebSocket for fills, `getOpenOrders`/`getTrades` on restart, CLOB balance-allowance plus on-chain balances for drift, Data API `/positions` for display.
8. Geoblock: check `GET` on polymarket.com at boot and before each order, fail closed. Run the execution host outside a blocked region.
9. Alerts: ntfy publish with two `http` actions (approve, reject), each carrying a one-time token bound to the pending order. Server verifies the token and state before submitting.
10. Re-check the rate-limit model (token buckets) and the deposit-wallet bug before Phase 6 implementation.

## 10. Blockers

1. Geoblock and ISP block: this machine cannot reach Polymarket, and Spain is reported as blocked (secondary sources). The execution host must be outside a blocked region, and the US is listed as blocked on the API geoblock page. Needs a decision from the user.
2. Deposit-wallet API key bug (issue #65, open): TS, Python, and Rust SDKs reportedly fail for signature types 0, 2, and 3. Blocks live order placement until a live test passes.
3. No primary docs access: the V2 migration guide, deposit-wallet page, trading-rate-limit page, and contracts page were only seen through search summaries. One run from an unblocked network should confirm the `[S]` items.
4. `@polymarket/client` order API not confirmed: the README does not document orders, and the migration summary is the only source for `placeOrder`. Read the published types before choosing a client.

## Sources

Fetched directly:
- https://registry.npmjs.org/@polymarket/client
- https://registry.npmjs.org/@polymarket/clob-client-v2
- https://registry.npmjs.org/@polymarket/clob-client
- https://registry.npmjs.org/web-push
- https://github.com/Polymarket/ts-sdk
- https://raw.githubusercontent.com/Polymarket/ts-sdk/main/README.md
- https://raw.githubusercontent.com/Polymarket/ts-sdk/main/packages/client/README.md
- https://raw.githubusercontent.com/Polymarket/clob-client-v2/main/README.md
- https://github.com/Polymarket/clob-client-v2/issues/65
- https://github.com/Polymarket/rs-clob-client-v2
- https://github.com/Polymarket/ctf-exchange-v2
- https://raw.githubusercontent.com/Polymarket/agent-skills/main/authentication.md
- https://raw.githubusercontent.com/Polymarket/agent-skills/main/order-patterns.md
- https://raw.githubusercontent.com/Polymarket/agent-skills/main/SKILL.md
- https://cdn.jsdelivr.net/npm/@polymarket/clob-client-v2@1.0.6/README.md
- https://substreams.dev/packages/polymarket/v0.3.0
- https://docs.ntfy.sh/publish/
- https://core.telegram.org/bots/api (partial)
- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://developer.mozilla.org/en-US/docs/Web/API/Notification/actions

Search summaries and third-party (not opened directly):
- https://docs.polymarket.com/v2-migration
- https://docs.polymarket.com/migrate/clob-sdk-to-unified-sdk
- https://docs.polymarket.com/getting-started/migrate-from-previous-sdks
- https://docs.polymarket.com/trading/deposit-wallets
- https://docs.polymarket.com/trading/realtime-order-updates
- https://docs.polymarket.com/market-data/websocket/user-channel
- https://docs.polymarket.com/api-reference/rate-limits
- https://docs.polymarket.com/api-reference/trading-rate-limits
- https://docs.polymarket.com/api-reference/geoblock
- https://docs.polymarket.com/resources/contracts
- https://docs.polymarket.com/polymarket-learn/FAQ/geoblocking
- https://github.com/cengizmandros/polymarket-cheatsheet (3P)
- https://www.mintlify.com/Polymarket/ctf-exchange/concepts/order-structure (3P mirror)
- https://www.mintlify.com/Polymarket/clob-client/concepts/authentication (3P mirror)
- https://startpolymarket.com/countries/spain/ (3P)
- https://gigazine.net/gsc_news/en/20260527-spain-blocks-polymarket-kalshi/ (3P)
- https://github.com/Polymarket/py-clob-client/issues/93 (3P)
- https://www.canadiangamingbusiness.com/2026/07/13/polymarket-blocks-provinces/ (3P)

## SDK typings check (2026-10-17)

Method: `npm pack` of `@polymarket/client@0.13.0` (npm latest), `@polymarket/clob-client-v2@1.2.0` (latest, npm-deprecated), plus `@polymarket/bindings@0.13.0` and `@polymarket/types@0.2.0` (dependencies, needed for enums). Read `.d.ts` and minified `dist/*.js`. Nothing executed, nothing installed into this repo. Scratch: `/tmp/claude-1000/-home-fresh-projects-polytech/b5492934-0a67-438f-9bcf-b62a3044a28e/scratchpad/sdk-probe/`.

### 1. @polymarket/client 0.13.0 (unified SDK, not deprecated on npm)

Trading is complete. Paths below are inside the tarball `package/dist/`.

- Instance methods, `SecureTradingActions` (`types-BGxCI8uu.d.ts` ~L6187-6491):
  - `createLimitOrder(PrepareLimitOrderRequest): Promise<SignedOrder>`, `placeLimitOrder(same): Promise<OrderResponse>` (create + sign + post).
  - `createMarketOrder(PrepareMarketOrderRequest)`, `placeMarketOrder(same)`. BUY takes `amount` (USD notional), SELL takes `shares`; `orderType` FOK (default) or FAK.
  - `postOrder(SignedOrder)`, `postOrders(SignedOrder[])` (1-15 per call), `waitForOrderFillSettlement(...)`.
  - `cancelOrder({ orderId })`, `cancelOrders({ orderIds: string[] })`, `cancelAll()`, `cancelMarketOrders({ assetId?, market? })`.
  - `listOpenOrders({ assetId?, market?, id?, cursor? }): Paginated<OpenOrder[]>`, `fetchOrder({ orderId })`.
  - `listAccountTrades({ assetId?, market?, makerAddress?, after?, before?, id?, cursor? }): Paginated<ClobTrade[]>` (instance method, L1512). `listTrades` is the public data-API variant.
- Standalone helpers, import from `@polymarket/client/actions` (`actions/index.d.ts`): `fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL | CONDITIONAL, assetId? })`, `updateBalanceAllowance`, `fetchTickSize`, `fetchNegRisk`, `fetchMarketInfo`, `createApiKey` / `deriveApiKey` / `createOrDeriveApiKey(client, { address, nonce, signature, timestamp })`. Balance is not an instance method.
- Order request: `assetId` (token ID or V2 position ID; `tokenId` deprecated), `price`, `size` (human units, number or string), `side`, `builderCode?`, `postOnly?`, `expiration?` (unix seconds, must be at least 3 min ahead). `expiration` set gives GTD, omitted gives GTC (`chunk-MY66WYAN.js`, `_P`/`li`).
- negRisk and tickSize are NOT caller parameters. The client resolves them per `assetId` from the market (`fetchCurrentMarket` -> `{ negRisk, tickSize, feeInfo }`) and picks the exchange (`He()` in `chunk-MY66WYAN.js`).
- Signature types: `SignatureType` in `@polymarket/bindings/clob` (`bind/.../dist/signature-type-CrLAA9AN.d.ts`): EOA=0, POLY_PROXY=1, POLY_GNOSIS_SAFE=2, POLY_1271=3. Chosen via `SecureClientOptions.wallet` (`types-BGxCI8uu.d.ts` ~L7071): omitted means the signer's deterministic Deposit Wallet (POLY_1271); pass the signer address to trade as EOA; or pass a Poly Proxy / Safe / Deposit Wallet address.
- Client creation: `createSecureClient({ signer, wallet?, credentials? | nonce?, environment?, apiKey?, onRateLimitUpdate? })` (L7130). L1 key derivation happens inside, so no separate call is needed. Its error union includes `DeployDepositWalletError` and `IsWalletDeployedError`, so it may deploy a deposit wallet; verify before use.
- Signer interface (L11410): `getAddress()`, `signTypedData(payload)`, `signMessage(hex)`, `sendTransaction(req)`. Adapters: `@polymarket/client/viem` exports `privateKey(pk, { chain?, transport? })` and `signerFrom(walletClient)`; also `/ethers-v5`, `/privy`.
- Peer deps (`package.json`): viem `^2.46.3`, ethers-v5 `^5.8.0`, @privy-io/node `^0.15.0`. All optional. Hard deps: ky, ox, zod ^4, it-merge, it-pushable, @msgpack/msgpack, @polymarket/types 0.2.0, @polymarket/bindings 0.13.0. Engines: node >= 24.
- Runtime: no browser-only APIs found. Uses `globalThis.crypto.subtle`, TextEncoder, atob/btoa, and `ky` for fetch. Expected to run on Node 24 (not executed; the probe only read source).

### 2. @polymarket/clob-client-v2 1.2.0 (deprecated on npm; points to the unified SDK)

- Usable and has the trading API, but it is the legacy line. `dist/client.d.ts`: `new ClobClient({ host, chain, signer?, creds?, signatureType?, funderAddress?, getSigner?, useServerTime?, builderConfig?, retryOnError?, throwOnError?, feeSlippage? })`.
- Methods: `createOrder`, `createMarketOrder`, `createAndPostOrder`, `postOrder(signed, orderType?, postOnly?, deferExec?)`, `postOrders`, `cancelOrder`, `cancelOrders`, `cancelAll`, `cancelMarketOrders`, `getOpenOrders`, `getTrades`, `getBalanceAllowance({ asset_type, token_id? })`, `updateBalanceAllowance`, `createOrDeriveApiKey(nonce?)`, `getTickSize`, `getNegRisk`.
- `UserOrderV2 = (tokenID | positionID) + { price, size, side, metadata?, builderCode?, expiration?, userUSDCBalance? }`. tickSize and negRisk are resolved automatically.
- Deps: viem `^2.46.3` (hard dep), axios, @ethersproject/wallet and providers. Node >= 20.10. No fetch injection.
- Verdict: works, but deprecated. Use it only as a fallback if the unified client fails the live test.

### 3. Wire facts (from source)

- L1 auth (`createL1Headers`, `clob-client-v2/dist/headers/index.js`; unified `is()` in `index.js`): EIP-712 domain `{ name: "ClobAuthDomain", version: "1", chainId }`; type `ClobAuth { address: address, timestamp: string, nonce: uint256, message: string }`; message `"This message attests that I control the given wallet"`. Headers: `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_NONCE`. Endpoints: `POST /auth/api-key`, `GET /auth/derive-api-key`.
- L2 HMAC (`clob-client-v2/dist/signing/hmac.js` `buildPolyHmacSignature`; unified `ds()` in `index.js`):
  - message = `${timestampSeconds}${METHOD}${requestPath}${body}`. Timestamp = `Math.floor(Date.now()/1000)`. METHOD uppercase. requestPath = path only, query string excluded, leading slash kept (e.g. `/order`). Body = `JSON.stringify(json)` only when a JSON body is sent; omitted for bodyless requests.
  - Secret: base64url-decode (`-`->`+`, `_`->`/`, strip non-base64 characters, `atob`), then use the bytes as the raw HMAC-SHA256 key.
  - Output: standard base64 of the digest, then `+`->`-` and `/`->`_`. Padding `=` is kept.
  - Headers: `POLY_ADDRESS` (signer EOA address), `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`.
- Order struct, identical in both packages (unified `Vi` in `chunk-MY66WYAN.js`; clob-v2 `ctfExchangeV2TypedData.js`):
  `Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)`.
  - `timestamp` = `Date.now()` in milliseconds. `metadata` and `builder` default to bytes32 zero.
  - `expiration`, `taker`, and `nonce` are NOT in the signed struct; `expiration` travels in the POST body.
- EIP-712 domain: `name: "Polymarket CTF Exchange"`, `chainId: 137`, `verifyingContract` = exchange, `version`:
  - `"2"` for the V2 exchange and the neg-risk V2 exchange.
  - `"3"` for `exchangeV3` (used for V2 position IDs). Unified: `protocolVersion = Ne(assetId) ? "3" : "2"`. clob-v2: `CTF_EXCHANGE_V3_DOMAIN_VERSION`.
- Production addresses (unified `index.js` production block; clob-v2 `config.js` MATIC_CONTRACTS agrees):
  - standard V2 exchange (`standardExchange`): `0xE111180000d2663C0091e4f400237545B87B996B`
  - neg-risk V2 exchange (`negRiskExchange`): `0xe2222d279d744050d28e00520010520000310F59`
  - `exchangeV3`: `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa`
  - Routing: V2 position ID -> `exchangeV3`; else `negRisk ? negRiskExchange : standardExchange`.
- Deposit-wallet (POLY_1271) orders are wrapped in an ERC-7739-style `TypedDataSign` envelope: domain `{ name: "DepositWallet", version: "1", chainId, verifyingContract: wallet }`, `salt` = zero. Both packages do this.
- Endpoints (unified, `chunk-MY66WYAN.js`): `POST /order`, `POST /orders`, `DELETE /order` (`{orderID}`), `DELETE /orders`, `DELETE /cancel-all`, `DELETE /cancel-market-orders`, `GET /data/orders`, `GET /data/order/{id}`, `GET /data/trades`, `GET /balance-allowance`, `GET /balance-allowance/update`, `GET /tick-size`, `GET /neg-risk`, `GET /markets-by-token/{id}`.

### 4. Injection (tests, base URL)

- Unified: no `fetch` or transport option in the public types. Base URL is overridable: `forkEnvironmentConfig({ name, chainId, clob: { rest: "http://127.0.0.1:PORT" } }, production)` (L6853), then pass the result as `environment`. Internally `ky.create({ prefixUrl: env.clob.rest })` with no fetch option forwarded. For tests, point `clob.rest` at a local HTTP server. Patching `globalThis.fetch` may also work, but that is unverified at runtime.
- clob-v2: `host` option only; axios is internal. Test via a local server on `host`.
- Neither package exposes a stub transport. Mock at the HTTP layer.

### Recommendation

- Package: `@polymarket/client@0.13.0` (pin exact version), `createSecureClient` with `@polymarket/client/viem` `privateKey()`.
- Methods: `placeLimitOrder` / `placeMarketOrder` (or `createX` + `postOrder`), `cancelOrder` / `cancelOrders` / `cancelAll` / `cancelMarketOrders`, `listOpenOrders`, `fetchOrder`, `listAccountTrades`, `fetchBalanceAllowance` (actions).
- Set `wallet` explicitly. EOA = signer address; default = Deposit Wallet (POLY_1271).
- Open risk: GitHub issue #65 (HTTP 400 on deposit-wallet and EOA keys) is independent of the SDK choice. Live-test both wallet modes before scoping Phase 6.
- Fallback if the unified SDK fails: raw REST + viem, using the HMAC, header, and EIP-712 facts above.

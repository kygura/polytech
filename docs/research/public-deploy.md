# Public deploy research (L0)

Date: 2026-10-18. Scope: Q1 to Q5 from the research brief. Read after `docs/research/execution.md`, which covers the order flow, auth headers, SDK typings and geoblock notes. This file does not repeat those; it cites them where it applies.

## Verdicts

- **Q1 Server signs orders for a user's wallet without per-order user signature?** Yes, but only by holding the signing key. No delegated signer, session key or operator mechanism lets a third party sign for user funds. CLOB L2 creds alone are NOT enough (no).
- **Q2 Browser dapp on non-polymarket origin calls clob directly, and signs in-browser?** CORS on clob.polymarket.com: unknown (not reachable from here, no primary source found). In-browser signing via a viem WalletClient: yes, via the `signerFrom(walletClient)` adapter in `@polymarket/client@0.13.0`. Browser runtime for that package: unverified.
- **Q3 Geoblock and Ireland?** Ireland is NOT allowed (no). Polymarket's API docs say builders should verify location before orders, and the Perps docs say builders must block submission. Exact endpoint URL and ToS text: unknown (not reachable).
- **Q4 Vercel and free-tier limits?** Hobby cron: 100 jobs, once per day, ±59 min. Pro cron: 100 jobs, once per minute. Hobby function max 300s. Pro 800s (1800s beta). Sandbox and Workflows both available on Hobby, but Hobby is non-commercial only. Neon and Upstash limits are listed below; connection limits: unknown.
- **Q5 wagmi + viem standard, Reown projectId, viem SIWE?** Yes: wagmi + viem is the standard path. WalletConnect needs a Reown projectId (yes). viem 2.57.7 ships `createSiweMessage` and `verifySiweMessage` under `viem/siwe` (yes).

## Access note

`docs.polymarket.com`, `polymarket.com` and `clob.polymarket.com` fail TLS from this machine (cert is `*.juegoilegal.es`). WebFetch hits the same error, so every Polymarket claim below comes from GitHub raw, npm tarballs, or WebSearch summaries of official pages. Those are tagged `[S]`. Primary GitHub and npm sources are tagged `[V]`.

## Q1. Server signing, signature types, delegation

### Who must sign, by signature type

The exchange checks the signature in `Signatures.sol` (`ctf-exchange-v2`, `src/exchange/mixins/Signatures.sol`):

| Type | Name | Rule enforced on-chain | Who can sign |
|---|---|---|---|
| 0 | EOA | `signer == maker` and ECDSA recovers to `signer` | The EOA key itself, every order |
| 1 | POLY_PROXY | ECDSA recovers to `signer`, and `getProxyWalletAddress(signer) == maker` | The EOA that deterministically owns the proxy |
| 2 | POLY_GNOSIS_SAFE | ECDSA recovers to `signer`, and `getSafeWalletAddress(signer) == maker` | The EOA that deterministically owns the Safe |
| 3 | POLY_1271 | `signer == maker`, maker has code, `isValidSignatureNow(maker, hash, sig)` | Whatever the wallet contract's EIP-1271 logic accepts (not verified) |

Sources: `https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/mixins/Signatures.sol` [V]. Type-to-name mapping also in `execution.md` section 3 and in `https://raw.githubusercontent.com/Polymarket/agent-skills/main/authentication.md` [V].

Consequence for types 1 and 2: the exchange does not check Safe owners or proxy owners. It recomputes the wallet address from the signer EOA. Adding extra owners to a Safe does not make an order from a different key valid. Only the deterministic EOA key can sign for that wallet.

### Operators and preapproval

- `matchOrders` and `preapproveOrder` are `onlyOperator`. Operators are added and removed by admins only (`Auth.sol`: `addOperator` is `onlyAdmin`). Source: `https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/mixins/Auth.sol` and `.../src/exchange/CTFExchange.sol` [V].
- An operator can post an order with an empty signature, but only if it was preapproved, and preapproval itself requires a valid signature from signer/maker (`_preapproveOrder`). So the user still signs once, and an operator cannot originate a signature. This is an operator-side optimization, not a user-facing delegation.
- A user cannot grant a third party an on-chain session key that the exchange accepts. The exchange has no such role.

### Builder code and relayer

- The order struct has `builder` (bytes32) and `metadata`, and the client exposes `builderCode`. These are attribution fields, not signing authority. Source: `execution.md` section 3 (order struct, from `chunk-MY66WYAN.js` and clob-v2 `ctfExchangeV2TypedData.js`) [V].
- Builder headers are for "order attribution and relayer access". Source: `https://raw.githubusercontent.com/Polymarket/agent-skills/main/authentication.md` [V]. The relayer is for gasless wallet deployment and transactions. Source: `https://raw.githubusercontent.com/Polymarket/agent-skills/main/gasless.md` [V]. Neither lets the relayer sign orders.

### Deposit wallet (type 3)

Validity is delegated to the wallet contract's `isValidSignature`. Whether the deposit-wallet contract accepts any extra signer (for example a server key) is unverified. The deposit-wallet source was not reachable. `[U]`. execution.md already marks the deposit-wallet API-key bug (issue #65) as blocking.

### L2 credentials alone

No. L2 headers only give the HMAC proof of the API key. `createL2Headers` still sets `POLY_ADDRESS` to the signer address (`clob-client-v2/dist/headers/index.js`, line 23). Orders additionally need an EIP-712 signature by the maker's signer key (`Signatures.sol` above). Source for the client shape: `https://raw.githubusercontent.com/Polymarket/clob-client-v2/main/README.md` [V] (auth section: L2 "Required for order placement, cancellation, and account data", with `signer` passed in the constructor).

## Q2. Browser calls, CORS, in-browser signing

### CORS

Unknown. Neither `clob.polymarket.com` nor any Polymarket docs page states CORS behavior. The host did not resolve from here (curl returned 000), and WebSearch found no statement. The CLOB may send `Access-Control-Allow-Origin`, but nothing I could read proves it. Test from a browser origin, with a real request, before designing around it.

One third-party proxy (`jsr.io/@hk/polymarket`) advertises CORS for web apps. That is a workaround, not Polymarket policy. Source: WebSearch summary, `https://jsr.io/@hk/polymarket` [S].

### createOrDeriveApiKey and signing with a browser wallet

- L1 derivation is an EIP-712 signature by the wallet (`ClobAuth`, `POLY_NONCE`). Source: `execution.md` section 2 and `clob-client-v2` README [V]. This works with any signer that can sign typed data, which includes a browser wallet.
- `@polymarket/client@0.13.0` exports `signerFrom(walletClient: WalletClient): Signer` from `@polymarket/client/viem`, and `privateKey(...)`. The `Signer` interface needs `getAddress`, `signTypedData`, `signMessage`, `sendTransaction`. Source: tarball `@polymarket/client@0.13.0` `dist/viem.d.ts` (fetched via `https://registry.npmjs.org/@polymarket/client/-/client-0.13.0.tgz`) [V]. So a MetaMask or WalletConnect `WalletClient` can be the signer. Browser runtime was not run; the package declares `engines.node >= 24` and no browser-only APIs were found in source (per `execution.md` SDK check) [V].
- `@polymarket/clob-client-v2@1.2.0` takes `signer: walletClient` in the README example (viem `createWalletClient`, `http()`). The README example uses a local account, not a browser provider. Browser support: unverified. It is deprecated on npm.

### Security note for a browser flow

The L2 `secret` would be in browser JS if orders are signed client-side with user-held creds. That is the user's own key, but the app cannot hold other users' creds server-side under this model. Keep the choice explicit in the design.

## Q3. Geoblock and Ireland

### Endpoint

GET on the polymarket.com domain (not the API hosts) returns `blocked`, `ip`, `country`, `region`. Exact URL unverified. Search summary cites `https://docs.polymarket.com/api-reference/geoblock` [S]. Source for the field list: same `[S]` summary. `execution.md` section 7 says the same thing.

### Builder obligation

- `[S]` WebSearch summary of `https://docs.polymarket.com/developers/CLOB/geoblock` and `https://docs.polymarket.com/api-reference/geoblock`: "Before placing orders, builders should verify the location." Orders from blocked regions are rejected. Builders should build geoblock checks into the app.
- `[S]` Perps docs (`https://docs.polymarket.com/perps/learn-about-trading/geographic-restrictions`): builders must block order submission entirely for users in listed jurisdictions, not only warn. The same applies to programmatic strategies acting for a user.
- ToS text on third-party frontends: not retrieved (`polymarket.com/tos` fails TLS). `[U]` whether the ToS itself mandates this for third-party frontends.

### Ireland

NO. Source: Irish Examiner, 21 July 2026, `https://www.irishexaminer.com/news/courtandcrime/arid-41883400.html` [S]. Quote: "Polymarket now lists Ireland as a restricted area alongside 36 other countries." Accounts located in Ireland "are currently restricted from depositing funds or opening new positions." Also reported by GamblingNews, `https://www.gamblingnews.com/news/polymarket-gets-blocked-in-ireland-as-european-crackdown-continues/` [S] (article dated 22 July 2026).

A third-party site, `https://startpolymarket.com/countries/ireland/`, says "close-only" and no IP block. It is older and carries affiliate links. Weight it low [3P].

Vercel `dub1` (Dublin) functions egress from Ireland, so the geoblock check would see an Irish IP. That is an inference from the geoblock rule (check on request origin IP), not a tested result. `[U]` until tested from that region.

## Q4. Vercel and free-tier limits

### Cron (Hobby vs Pro)

Source: `https://vercel.com/docs/cron-jobs/usage-and-pricing` (last updated 2026-07-15) [V].

| Plan | Jobs per project | Minimum interval | Precision |
|---|---|---|---|
| Hobby | 100 | Once per day | Per-hour (±59 min) |
| Pro | 100 | Once per minute | Per-minute |

Hobby expressions like `0 * * * *` fail at deploy.

### Function max duration

Source: `https://vercel.com/docs/functions/configuring-functions/duration` [V].

| Plan | Default | Max | Extended (beta) |
|---|---|---|---|
| Hobby | 300s | 300s | - |
| Pro | 300s | 800s | 1800s (per-function config) |

### Sandbox on Hobby

Available. Source: `https://vercel.com/docs/sandbox/pricing` (last updated 2026-09-10) [V].

- Included on Hobby: 5 Active CPU hours/month, 420 GB-hours provisioned memory, 5,000 creations, 20 GB data transfer.
- Max session 45 min. Max 4 vCPU, 8 GB on Hobby. 10 concurrent sandboxes.
- Over quota: creation is paused until 30 days after first use. Not charged.
- Pro: $0.128/hour active CPU, $0.0212/GB-hour memory, 24h session, charged against the $20 monthly credit.

### Workflows on Hobby

Available. The Hobby plan lists "Workflow Events 50,000 / month included" and "Workflow Data Written 1 GB". Source: `https://vercel.com/docs/plans/hobby` (last updated 2026-09-14) [V]. Workflows overview: `https://vercel.com/docs/workflows` [V]. Pricing page not read separately.

### Hobby is non-commercial

`https://vercel.com/docs/plans/hobby`: "the Hobby plan restricts users to non-commercial, personal use only." This matters for a trading app that could handle other people's funds. Pro is needed for commercial use. Source [V].

### Other Hobby limits that matter

From `https://vercel.com/docs/plans/hobby` [V]: Function invocations 1,000,000 included; Active CPU 4 CPU-hours; Provisioned Memory 360 GB-hours; Fast Data Transfer 100 GB. Runtime logs: 1 hour on Hobby, 1 day on Pro (`https://vercel.com/docs/limits` [V]).

### Neon (via Vercel Marketplace)

Limits from `https://neon.com/pricing` [V] (Neon's own pricing page, fetched directly):

- 1 GB per project, 20 GB total across the account.
- 100 CU-hours per project per billing period. Compute pauses when exhausted.
- 100 projects. 10 branches per project.
- Autoscaling up to 2 CU (8 GB RAM).
- Max concurrent connections: not stated. `[U]`.

Marketplace billing is through Vercel (`https://vercel.com/marketplace/neon` [V]). That page gives no numbers and it is not confirmed that Marketplace plans match neon.com limits. `[U]`.

### Upstash Redis (via Vercel Marketplace)

Limits from `https://upstash.com/pricing/redis` [V] (fetched directly):

- 500K commands per month. 250 MB data. 10 GB monthly bandwidth. Max request size 10 MB.
- No daily command cap found. Connection limit: not stated. `[U]`.
- Marketplace billing: not separately verified. `[U]`.

## Q5. Wallet stack, WalletConnect projectId, SIWE

### Standard stack

wagmi + viem is the standard for Next.js App Router and Polygon (`chainId 137`). Current npm latest (checked 2026-10-18): `wagmi@3.7.7` (published 2026-08-27), `viem@2.57.7` (published 2026-10-14), `@rainbow-me/rainbowkit@2.2.11` (2026-05-06), `connectkit@1.9.2` (2026-03-24), `@reown/appkit@1.8.24` (2026-09-16) [V] (`https://registry.npmjs.org/<pkg>`).

- Plain injected connector (MetaMask-style, `window.ethereum`): wagmi ships an `injected()` connector. Not separately fetched in this run. `[U]` for exact API on v3.
- RainbowKit or ConnectKit are optional UI layers over wagmi. The App Router SSR guide (`https://wagmi.sh/react/guides/ssr`) documents `ssr: true`, cookie storage and `cookieToInitialState`. That page was read as served; it may describe wagmi 2.x patterns. Recheck against wagmi 3 before coding.
- viem 2.57.7 was published 4 days before this note. Under the two-week rule for pinning in artifacts, pin the previous release. `[V]` for the date.

### WalletConnect projectId

Yes, required. Sources:
- Reown docs: "Create a new project on Reown Dashboard and obtain a new project ID." `https://docs.reown.com/appkit/next/core/installation` [V]. The wagmi config example throws "Project ID is not defined" when missing. The CLI-provided projectId "will only work on `localhost`" (same page).
- wagmi `@wagmi/connectors@8.2.0` passes `parameters.projectId` into the WalletConnect provider (`dist/esm/walletConnect.js`, line 172) [V].
- RainbowKit 2.2.11 passes `projectId` through its WalletConnect connector (`dist/wallets/walletConnectors/chunk-ZUZCDLRJ.js`, lines 12 and 58) [V].

### SIWE

Yes, built into viem. viem@2.57.7 tarball exports `viem/siwe` with `createSiweMessage`, `verifySiweMessage` and `generateSiweNonce` (`_types/siwe/index.d.ts`; package export `./siwe`) [V]. Import path: `import { createSiweMessage, verifySiweMessage, generateSiweNonce } from 'viem/siwe'`. Docs example also shows `publicClient.verifySiweMessage(...)`, which is the client-action form. Source: `https://viem.sh/docs/siwe/actions/verifySiweMessage` (WebFetch) [V]. Version note: first release that exported these was not checked. `[U]`.

## Unknown and not verified

- CORS on clob.polymarket.com (Q2). `[U]`
- Exact geoblock URL and ToS wording on third-party frontends (Q3). `[U]`
- Deposit-wallet (type 3) signer acceptance (Q1). `[U]`
- Neon and Upstash connection limits, and Marketplace plan parity (Q4). `[U]`
- Browser runtime for `@polymarket/client` and `clob-client-v2` (Q2). `[U]`
- Plain injected connector API on wagmi 3 (Q5). `[U]`

## Sources

Primary (fetched or downloaded this run):
- https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/mixins/Signatures.sol
- https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/mixins/Auth.sol
- https://raw.githubusercontent.com/Polymarket/ctf-exchange-v2/main/src/exchange/CTFExchange.sol
- https://raw.githubusercontent.com/Polymarket/clob-client-v2/main/README.md
- https://raw.githubusercontent.com/Polymarket/agent-skills/main/authentication.md
- https://raw.githubusercontent.com/Polymarket/agent-skills/main/gasless.md
- https://registry.npmjs.org/@polymarket/client (tarball 0.13.0)
- https://registry.npmjs.org/@polymarket/clob-client-v2 (tarball 1.2.0)
- https://registry.npmjs.org/viem (tarball 2.57.7)
- https://registry.npmjs.org/@rainbow-me/rainbowkit (tarball 2.2.11)
- https://registry.npmjs.org/@wagmi/connectors (tarball 8.2.0)
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/workflows
- https://vercel.com/docs/limits
- https://vercel.com/marketplace/neon
- https://neon.com/pricing
- https://upstash.com/pricing/redis
- https://docs.reown.com/appkit/next/core/installation
- https://viem.sh/docs/siwe/actions/verifySiweMessage
- https://wagmi.sh/react/guides/ssr

Secondary (WebSearch summaries or third-party):
- https://www.irishexaminer.com/news/courtandcrime/arid-41883400.html (news, 21 Jul 2026)
- https://www.gamblingnews.com/news/polymarket-gets-blocked-in-ireland-as-european-crackdown-continues/ (news)
- https://docs.polymarket.com/api-reference/geoblock (WebSearch summary)
- https://docs.polymarket.com/developers/CLOB/geoblock (WebSearch summary)
- https://docs.polymarket.com/perps/learn-about-trading/geographic-restrictions (WebSearch summary)
- https://docs.polymarket.com/polymarket-learn/FAQ/geoblocking (from execution.md)
- https://startpolymarket.com/countries/ireland/ (3P, low weight)
- https://jsr.io/@hk/polymarket (3P proxy, not Polymarket policy)

## Q6. Free scheduling: GitHub Actions vs Vercel Hobby vs always-on host

Method: WebFetch of the primary URLs below on 2026-10-18. Numbers are tool-summarized from fetched pages; re-verify before relying on one.

Implication: vercel.json crons that run more than once per day fail deployment on Hobby (cron page below), so sub-daily triggers need GitHub Actions `schedule` or an always-on host.

### 1. GitHub Actions `schedule`
- Minimum interval: 5 minutes. https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- Delay/drop: can be delayed under high load; "some queued jobs may be dropped" if load is high enough. Same URL.
- Default branch only: yes. Workflow file must exist on the default branch; scheduled runs only on the default branch. Same URL.
- Auto-disable: public repos only, after 60 days with no repo activity. Private repos: unknown (not stated; the disable-and-enable page returned 404). Same URL.

### 2. GitHub Actions billing and limits
- Free, private repos: 2,000 included min/month. Linux 2-core list price $0.006/min. Linux minute multiplier: unknown (not stated on fetched pages). https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- Public repos: standard GitHub-hosted runners are free. Same URL.
- Max job duration: 6 hours. Max workflow run: 35 days. Free concurrency: 20 jobs total (5 macOS). Public-repo concurrency: unknown. https://docs.github.com/en/actions/reference/limits
- Storage (Free): artifacts 500 MB (shared with Packages), cache 10 GB/repo. Same URL as billing above.

### 3. GitHub-hosted runner egress
- Verdict: region and IP ranges unknown. Linux/Windows runners run on Microsoft Azure VMs; no default region or US claim is stated. https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners
- IP ranges are published via the `actions` key of GET https://api.github.com/meta (ranges only, no region labels). https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Polymarket geoblock: runner egress still needs a direct check against Polymarket's own geoblock endpoint before relying on any job.

### 4. Vercel Hobby: Sandbox and Workflow
- Sandbox Hobby included: 5 Active CPU hrs/month, 420 GB-hrs provisioned memory, 5,000 creations, 20 GB network, 10 concurrent sandboxes, 45 min max session, max 4 vCPU / 8 GB. https://vercel.com/docs/sandbox/pricing
- Sandbox at limit: creation is paused until 30 days after first use; no charge. Same URL.
- Workflow Hobby included: 50,000 events/month, 1 GB data written. https://vercel.com/docs/plans/hobby
- Workflow at limit: unknown for Workflows specifically (workflows pricing page not fetched). General Hobby rule: exceeded limits wait for the 30-day cycle. Same URL.
- Fair use: Hobby is "restricted to non-commercial, personal use only." Commercial = any deployment used for financial gain, including requesting/processing visitor payments or a paid developer. Donations are not commercial. https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage
- Blocker: if the trading app takes payment or fees, Hobby is out; that needs Pro.

### 5. Railway
- Free: $0/month, $1 monthly credit. Trial: one-time $5 credit, no card; duration shown as 30 days on the pricing page but "not stated" on the plans doc. https://railway.com/pricing and https://docs.railway.com/reference/pricing/plans
- Hobby: $5/month, includes $5 of usage. Does not say whether this covers always-on services. Same URLs.
- Rates (plans doc): $20/vCPU/month, $10/GB/month. Sleep configuration: not stated.
- Cheapest always-on price: unknown as a product. Derived by me, not Railway's claim: at those rates $5 covers about 0.25 vCPU always-on with no memory.

### 6. GitHub Actions calling a Vercel function on a schedule (curl + bearer)
- Verdict: no Hobby rule against external triggering found in the fair-use, Hobby, or cron pages fetched. https://vercel.com/docs/limits/fair-use-guidelines and https://vercel.com/docs/plans/hobby
- The once-per-day limit applies to vercel.json cron jobs only (cron page). External HTTP calls count as Function Invocations (1M/month included) and Active CPU (4 hrs/month included). https://vercel.com/docs/cron-jobs/usage-and-pricing
- Deployment Protection: automation bypass header `x-vercel-protection-bypass` is available on all plans. https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
- Fair use warns against "circumventing or otherwise misusing Vercel's limits." Keep cadence modest.

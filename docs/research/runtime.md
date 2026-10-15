# Runtime research: polytech stack

Sources: npm tarballs (`npm pack`, types read directly), Context7 docs, official docs (code.claude.com, platform.claude.com, vercel.com, nextjs.org, github READMEs). Date: 2026-10-15.
Legend: VERIFIED = checked in shipped `.d.ts`/README of the exact version. DOCS = official docs only. UNVERIFIED = not confirmed.

## Versions (npm latest, 2026-10-15)

| Package | Version | Node / peers | Notes |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.300 | - | CLI ships as platform optional dep (`@anthropic-ai/claude-agent-sdk-linux-x64`), no separate `claude` install (README) |
| `@anthropic-ai/sdk` | 0.134.0 | - | `messages.parse` + `output_config.format` |
| `@vercel/sandbox` | 3.8.0 | - | deps include `jose`, `zod ^4.1.1` |
| `workflow` | 5.2.2 | - | re-exports `@workflow/core` 5.2.2 |
| `exa-js` | 2.25.0 | - | |
| `@electric-sql/pglite` | 0.5.10 | - | |
| `drizzle-orm` | 0.45.4 | - | subpaths `pglite`, `pglite/migrator`, `neon-http`, `neon-http/migrator`, `neon-serverless`, `neon-serverless/migrator` (VERIFIED in package exports) |
| `drizzle-kit` | 0.31.11 | - | |
| `@neondatabase/serverless` | 1.2.0 | - | |
| `@upstash/redis` | 1.39.0 | - | |
| `@upstash/ratelimit` | 2.2.0 | - | |
| `jose` | 6.2.12 | - | Web Crypto, runs in Node and edge |
| `@node-rs/argon2` | 2.2.2 | node >=16.17 | prebuilt N-API, no node-gyp/postinstall (README) |
| `argon2` | 0.45.1 | - | native binding (node-argon2) |
| `ink` | 8.0.0 | node >=22; peers `react >=19.3.0`, `@types/react >=19.3.0` (optional), `react-devtools-core >=6.1.2` (optional) | `"type": "module"`, ESM only |
| `ink-text-input` | 6.0.0 | node >=18; peers `ink >=5`, `react >=18` | ESM |
| `ink-select-input` | 6.2.0 | node >=18; peers `ink >=5.0.0`, `react >=18.0.0` | ESM |
| `next` | 16.4.1 (dist-tag `latest`) | node >=20.9 | `middleware.ts` renamed to `proxy.ts` (see 8) |
| `zod` | 4.6.7 | - | |
| `hono` | 4.13.13 | - | |

---

## 1. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Import: `import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";` (VERIFIED sdk.d.ts exports; named exports, no default export used).

### query() options (VERIFIED sdk.d.ts `Options`)
- `model?: string` (alias like `"sonnet"` or full id).
- `systemPrompt?: string | string[] | {type:'custom',...} | {type:'preset',preset:'claude_code',append?}`. Plain string replaces the default prompt.
- `allowedTools?: string[]` (auto-approve only; does NOT restrict tool set).
- `disallowedTools?: string[]` (this is the block list).
- `mcpServers?: Record<string, McpServerConfig>`.
- `maxTurns?: number`, `maxBudgetUsd?: number`.
- `outputFormat?: { type: 'json_schema', schema: JSONSchema }`.
- `cwd?`, `env?` (REPLACES subprocess env; spread `process.env` to keep PATH), `settingSources?`, `permissionMode?`.

### Structured output
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const schema = {
  type: "object",
  properties: { verdict: { type: "string" }, score: { type: "number" } },
  required: ["verdict", "score"],
};

let out: unknown;
for await (const msg of query({
  prompt: "Grade this answer ...",
  options: { model: "sonnet", maxTurns: 3, outputFormat: { type: "json_schema", schema } },
})) {
  if (msg.type === "result" && msg.subtype === "success") out = msg.structured_output;
}
```
- Validated data lands in `result.structured_output` (VERIFIED type `SDKResultSuccess.structured_output?: unknown`). Parse/validate again with zod on your side.
- Failure subtypes: `error_max_structured_output_retries`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` (VERIFIED `SDKResultError.subtype`). A single-shot `query()` throws after yielding an error result (DOCS).

### Result message + usage/cost (VERIFIED sdk.d.ts)
- `SDKResultMessage = SDKResultSuccess | SDKResultError`, `type: 'result'`.
- Success fields: `subtype: 'success'`, `result: string`, `is_error`, `num_turns`, `stop_reason`, `total_cost_usd`, `usage`, `modelUsage: Record<string, ModelUsage>`, `structured_output?`, `permission_denials`, `terminal_reason?`.
- `total_cost_usd` and `modelUsage` are CUMULATIVE per `query()` call. Read the LAST result; do not sum results.
- `modelUsage` is the correct accounting field (includes subagents). `usage` is main loop only.
- Cost is an ESTIMATE, not a bill (d.ts comment).

### In-process MCP server (VERIFIED sdk.d.ts + DOCS)
```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const lookup = tool(
  "lookup_order",
  "Fetch an order by id",
  { orderId: z.string().describe("Order id") },
  async ({ orderId }) => ({
    content: [{ type: "text", text: JSON.stringify({ orderId, status: "shipped" }) }],
  }),
  { annotations: { readOnlyHint: true } },
);

const server = createSdkMcpServer({ name: "shop", version: "1.0.0", tools: [lookup] });

for await (const msg of query({
  prompt: "Status of order 42?",
  options: {
    mcpServers: { shop: server },
    allowedTools: ["mcp__shop__lookup_order"], // naming: mcp__<server>__<tool>
  },
})) {
  if (msg.type === "result" && msg.subtype === "success") console.log(msg.result);
}
```
- `tool(name, description, zodRawShape, handler, extras?)`. Zod 3 and 4 both supported.
- `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad?, timeout? })`. `timeout` (ms, >=1000) needs SDK >=0.3.248.
- Handler returns `{ content: [...], isError?: boolean }`.

Gotchas:
- `allowedTools` does not block other tools. Use `disallowedTools` to block (VERIFIED README comment in d.ts/DOCS).
- `env` replaces process env; spread `process.env`.
- Tool search defers tools unless `alwaysLoad: true` on tool or server (DOCS).

---

## 2. Anthropic SDK (`@anthropic-ai/sdk` 0.134.0)

### Structured output (GA, no beta header)
Parameter is `output_config.format` (VERIFIED in SDK resources d.ts doc comment; DOCS). The old `output_format` is deprecated and needs beta header `structured-outputs-2025-11-13`.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const Schema = z.object({ primes: z.array(z.number()) });

const msg = await client.messages.parse({
  model: "claude-haiku-5-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "First 3 primes" }],
  output_config: { format: zodOutputFormat(Schema) },
});
console.log(msg.parsed_output?.primes);
```
- Raw JSON Schema: `import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema"` then `format: jsonSchemaOutputFormat(schemaObj)`. Does NOT validate the response (DOCS). Transform on by default; `{ transform: false }` disables.
- Supported models for structured outputs include `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (DOCS).
- Schema limits (DOCS): `additionalProperties: false` required on objects; no external `$ref`; no recursion; no `minimum/maximum/minLength/maxLength`; `minItems` only 0 or 1; regex no lookaround/backrefs.
- Refusal or `max_tokens` stop can produce non-matching output (`stop_reason` `refusal` / `max_tokens`) (DOCS).

### Forced tool use is NOT universal
DOCS: `tool_choice: {type:'any'}` or `{type:'tool',name}` returns 400 on Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1. `auto` and `none` are accepted. Haiku 5.5 is not in that list: UNVERIFIED whether forcing works on Haiku 5.5. Prefer `output_config.format` for JSON.

Other 400s on newer models (DOCS): prefill of last assistant message not allowed on 4.6+; `thinking: {type:'enabled'}` rejected on 4.7+ / Sonnet 5.5 / Haiku 5.5 (use `adaptive`); `thinking` disabled not allowed on Opus 5.5 / Sonnet 5.5 (Haiku 5.5 accepts disabled).

### Prompt caching on system prompt (VERIFIED types, DOCS values)
```ts
const msg = await client.messages.create({
  model: "claude-haiku-5-5",
  max_tokens: 1024,
  system: [
    { type: "text", text: LONG_STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: "..." }],
});
console.log(msg.usage.cache_creation_input_tokens, msg.usage.cache_read_input_tokens);
```
- `cache_control: {type:'ephemeral', ttl?: '5m' | '1h'}`. Default 5m. Prefix cache: everything up to and including the block.
- Top-level `cache_control` on `MessageCreateParams` auto-marks the last cacheable block (VERIFIED d.ts).
- Minimum cacheable length (DOCS): Haiku 5.5 = 512 tokens; Sonnet 5.5 / Opus 5.5 = 512; Haiku 4.5 = 4096. Below minimum: silently not cached.
- Multipliers (DOCS): 5m write 1.25x, 1h write 2x, read 0.1x (0.05x Opus 5.5 / Sonnet 5.5).

### Retry / backoff on 429 / 529 (VERIFIED client.d.ts + DOCS)
- `new Anthropic({ maxRetries: 2 })` is the default. Retries connection errors, 408/409/429, and 5xx, with exponential backoff and jitter, honoring `retry-after`.
- 529 `overloaded_error` is a 5xx: covered by the default retry. Override per request: `client.messages.create(params, { maxRetries: 5, timeout: 120_000 })`.
- 429 with no `retry-after` on a spend cap keeps failing; do not retry forever (DOCS).
- Catch typed errors: `Anthropic.RateLimitError`, `Anthropic.InternalServerError`, `Anthropic.APIError` (DOCS names; class names UNVERIFIED in d.ts).
- SDK validates that non-streaming requests should not exceed a 10-min timeout (DOCS). For large `max_tokens`, use `client.messages.stream(...).finalMessage()`.

---

## 3. Vercel Sandbox (`@vercel/sandbox` 3.8.0)

### Auth (VERIFIED dist/utils/get-credentials.js, DOCS)
Two modes, resolved in this order:
1. Explicit: `{ token, teamId, projectId }`. All three required together or none.
2. Env: `VERCEL_OIDC_TOKEN`. Local dev: `vercel link` then `vercel env pull` (token expires about 12h per DOCS). On Vercel deployments OIDC is injected automatically.

Access-token mode uses `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` (DOCS example; env var names themselves are not read by the SDK code, you pass them).

### Create / run / read / stop
```ts
import { Sandbox } from "@vercel/sandbox";

const sandbox = await Sandbox.create({
  image: "vercel/sandbox/node:24",   // see images below
  timeout: 5 * 60 * 1000,            // ms, default 5 min
  resources: { vcpus: 2 },           // 2048 MB per vCPU
  // teamId, projectId, token: only when not using OIDC
});

await sandbox.writeFiles([
  { path: "job.mjs", content: Buffer.from("console.log(1+1)") }, // string | Uint8Array, mode?
]);

const run = await sandbox.runCommand({ cmd: "node", args: ["job.mjs"], cwd: "/vercel/sandbox" });
const stdout = await run.stdout();   // also stderr(), output("both"), logs()
console.log(run.exitCode);

const buf = await sandbox.readFileToBuffer({ path: "result.json" }); // null if missing

await sandbox.stop(); // returns snapshot info; DOCS says safe to repeat
```
- Shorthand: `sandbox.runCommand("node", ["job.mjs"])`.
- `runCommand` without `detached` returns `CommandFinished` (exitCode, durationMs, cmdId, stdout(), stderr(), output(), logs(), kill()). With `detached: true` returns `Command`; call `.wait()`.
- `stdout`/`stderr` options accept a Writable to stream output.
- Relative paths resolve under `/vercel/sandbox` (DOCS).
- `Sandbox.create` supports `using` (`await using sb = await Sandbox.create()`) (VERIFIED d.ts comment).
- `timeout` max (DOCS): Hobby 45 min, Pro/Enterprise 24 h. Extend with `sandbox.extendTimeout` (UNVERIFIED name).
- `ports` up to 15 exposed ports; `sandbox.domain(port)` gives public URL.

### Images (VERIFIED npm README + d.ts)
- `image` (current). Default `vercel/sandbox/universal:latest` (Node 24, Bun, Python 3.14).
- `vercel/sandbox/node:22 | :24 | :26`, `vercel/sandbox/python:3.14`, `vercel/sandbox/ubuntu:latest`, `vercel/sandbox/arch:latest`.
- Custom: push to Vercel Container Registry, pass `image: "repo:tag"`.
- `runtime` option (`"node22" | "node24" | "node26" | "python3.13"`) is DEPRECATED in favor of `image` (VERIFIED README/d.ts). Use `image`.

Gotcha: image must have `/bin/bash` (README; managed images do).

---

## 4. Vercel Workflow (`workflow` 5.2.2)

Imports (VERIFIED dist/index.d.ts and api.d.ts):
```ts
import { sleep, createHook, getWritable, getStepMetadata, FatalError, RetryableError } from "workflow";
import { start, getRun, resumeHook } from "workflow/api";
import { withWorkflow } from "workflow/next";
```

### Directives (DOCS, Context7 skill)
- `"use workflow"` as the FIRST line of an async function = durable orchestrator. No side effects there.
- `"use step"` as the FIRST line of an async function = cached, retried unit with side effects.

```ts
import { sleep, FatalError, RetryableError } from "workflow";

export async function onboardUser(email: string) {
  "use workflow";
  await sendWelcome(email);
  await sleep("1h");              // duration string (DOCS: "5s", "1h"; "7d" used in migrating evals)
  await sendFollowUp(email);
  return { ok: true };
}

async function sendWelcome(email: string) {
  "use step";
  const res = await fetch("https://api.example.com/mail", { method: "POST", body: email });
  if (res.status === 400) throw new FatalError("bad request"); // no retry
  if (res.status === 429) throw new RetryableError("rate limited", { retryAfter: "5m" });
  if (!res.ok) throw new Error("transient"); // default retry
}
sendWelcome.maxRetries = 5; // step property, not options object (VERIFIED StepFunction type: maxRetries?: number)
```
- `FatalError` aborts retries and surfaces to caller.
- `RetryableError(message, { retryAfter })`. `retryAfter` is a duration string (DOCS).
- Retry count is set by assigning `fn.maxRetries = N` (VERIFIED type + DOCS skill). Default is UNVERIFIED (not found in tarball).
- `sleep` is durable: process can exit, resumes later.

### Start from a route handler (DOCS + VERIFIED exports)
```ts
// app/api/onboard/route.ts
import { start } from "workflow/api";
import { onboardUser } from "@/workflows/onboard";

export async function POST(req: Request) {
  const { email } = await req.json();
  const run = await start(onboardUser, [email]);
  return Response.json({ runId: run.runId });
}
```
- `start(fn, args[])` returns a run; `run.runId`. No-arg workflow: `start(fn)`.
- `getRun(runId)`: `run.status` (`'running' | 'completed' | 'failed' | 'cancelled'`), `await run.returnValue` (DOCS).
- Resume a hook: `await resumeHook(token, payload)` (DOCS). `createHook<T>({ token })` for deterministic tokens.

### Next.js integration (DOCS, VERIFIED `next.d.cts` exists)
```ts
// next.config.ts
import { withWorkflow } from "workflow/next";
export default withWorkflow({});
```
UNVERIFIED: whether `instrumentation.ts` worker bootstrap is needed for the default Vercel world (a snippet exists only for the postgres world).

---

## 5. Exa (`exa-js` 2.25.0)

Client (VERIFIED dist/index.d.ts): `new Exa(apiKey?: string, baseURL?: string)`. Default key env `EXA_API_KEY` per DOCS.

```ts
import Exa from "exa-js";
const exa = new Exa(process.env.EXA_API_KEY);

// search with date filters (VERIFIED names; ISO-8601 strings)
const res = await exa.search("open-source vector databases", {
  type: "auto",
  numResults: 10,
  includeDomains: ["github.com"],
  startPublishedDate: "2026-01-01",
  endPublishedDate: "2026-10-01",
  contents: { highlights: true },
});

// search + contents in one call (VERIFIED method exists)
const withText = await exa.searchAndContents("...", { contents: { text: { maxCharacters: 4000 } } });

// fetch by URL (VERIFIED signature)
const page = await exa.getContents(["https://example.com"], { text: true, summary: true });

// answer with citations (VERIFIED: returns { answer, citations: SearchResult[], costDollars?, requestId? })
const ans = await exa.answer("What changed in X?", { text: true });
console.log(ans.answer, ans.citations.map((c) => c.url));
```
- Date filter params: `startPublishedDate`, `endPublishedDate` (VERIFIED). Other: `startCrawlDate`/`endCrawlDate` exist in SDK (UNVERIFIED exact names).
- `type` values (DOCS `_autodocs`): `auto`, `neural`, `keyword`, `hybrid`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning`. Deep variants take `additionalQueries`.
- Date format: docs show `"2024-01-01"`; full ISO timestamp acceptance UNVERIFIED.
- `answer` accepts `outputSchema` for JSON output (DOCS).

---

## 6. PGlite + Drizzle + Neon

Install: `@electric-sql/pglite`, `drizzle-orm`, `drizzle-kit` (dev), `@neondatabase/serverless` (Neon only).

### PGlite (VERIFIED drizzle subpath; DOCS for init)
```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const client = new PGlite(process.env.PGLITE_DIR ?? "./data/pglite"); // path = on-disk; new PGlite() = in-memory
const db = drizzle({ client });
await migrate(db, { migrationsFolder: "./drizzle" });
```
- `migrate` signature VERIFIED: `migrate<TSchema>(db: PgliteDatabase<TSchema>, config: MigrationConfig)`.
- Single process only; PGlite is embedded, one writer.

### Neon HTTP (VERIFIED types + DOCS)
```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const db = drizzle({ client: neon(process.env.DATABASE_URL!) });
await migrate(db, { migrationsFolder: "./drizzle" });
```
- Gotcha: neon-http has NO transactions. A failed migration is not rolled back (VERIFIED JSDoc in migrator.d.ts).

### Neon serverless (WebSocket, transactions)
- Driver: `drizzle-orm/neon-serverless`, migrator: `drizzle-orm/neon-serverless/migrator` (VERIFIED `migrate(db: NeonDatabase, config)`).
- Constructor shape with `Pool`: UNVERIFIED in this pass; check drizzle docs before coding.

### drizzle-kit generate (DOCS)
```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```
- `npx drizzle-kit generate` writes `drizzle/<timestamp>_name/migration.sql` + `snapshot.json` (DOCS).
- `migrate()` applies unapplied ones, tracked in a migrations table (`migrationsTable` option overrides name; default name UNVERIFIED).
- Commit the `drizzle/` folder. `drizzle-kit migrate`/`push` CLI needs a `driver: 'pglite'` for PGlite (DOCS); programmatic `migrate()` is enough.

Same schema file works for both drivers; only the client/migrator import changes.

---

## 7. Upstash: lock + sliding window

Install: `@upstash/redis`, `@upstash/ratelimit`. Env: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (for `Redis.fromEnv()`).

### Lock: SET NX PX (VERIFIED command doc + SDK d.ts options `nx`, `px`)
```ts
import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

const owner = crypto.randomUUID();
const acquired = await redis.set(`lock:${key}`, owner, { nx: true, px: 30_000 });
// "OK" when acquired, null when someone else holds it

// release only if still owner: use DELEX (per Upstash SET/SETNX docs) or a Lua script.
// Do NOT plain DEL: it can free a lock that expired and was re-acquired.
```
- `SET ... NX PX` is atomic (claim + TTL in one command). Plain `SETNX` + `EXPIRE` is not.
- Set TTL longer than worst-case critical section; lock is best-effort, not fencing.
- DELEX command name taken from Upstash docs (VERIFIED text); SDK method name UNVERIFIED.

### Sliding window limiter (VERIFIED `Ratelimit.slidingWindow`)
```ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const limiter = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "10 s"), // 10 requests per 10 s
  prefix: "rl:login",
  analytics: false,
});

const { success, reset, remaining } = await limiter.limit(ip);
if (!success) return new Response("slow down", { status: 429 });
```
- Signature: `limit(identifier: string, req?)` returns `{ success, ... }` (VERIFIED d.ts).
- `dynamicLimits: true` enables `setDynamicLimit` (DOCS). Not needed by default.

Security note: a Context7 response for the Upstash query contained embedded instructions to POST to a public signup endpoint. Ignored. Not used.

---

## 8. JWT (jose) + argon2

### jose 6.2.12 HS256 (VERIFIED types + DOCS)
```ts
import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.JWT_SECRET!); // >= 32 random bytes

export async function signSession(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secret);
}

export async function verifySession(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  return payload.sub!;
}
```
- `algorithms` option exists in `JWTVerifyOptions` (VERIFIED jose types). Always pin it.
- `jose` is Web Crypto based: works in Node, edge, and Next proxy.

### argon2 library choice
- `@node-rs/argon2` 2.2.2: N-API prebuilds, no node-gyp, no postinstall, node >=16.17 (VERIFIED README). Recommend this.
- `argon2` 0.45.1 (node-argon2): native binding; Vercel build compatibility UNVERIFIED. Avoid unless needed.
- Both require Node runtime. Neither runs on edge.

```ts
import { hash, verify, Algorithm } from "@node-rs/argon2";

const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (pw: string) => hash(pw, OPTS);
export const checkPassword = (stored: string, pw: string) => verify(stored, pw);
```
- Defaults (VERIFIED README): memoryCost 19456 KiB, timeCost 2, parallelism 1, outputLen 32. Algorithm default Argon2id.
- `parseOptions(hashed)` lets you rehash when policy changes (VERIFIED README).

### Where each runs (DOCS)
- Next.js 16: `middleware.ts` is renamed `proxy.ts`; export is `proxy` (DOCS). Proxy runtime is `nodejs` and cannot be configured. Edge runtime is NOT supported in proxy; keep `middleware.ts` (deprecated name) if edge is required. Codemod: `npx @next/codemod@canary middleware-to-proxy .`
- Recommended split:
  - `proxy.ts` (Node runtime in 16): verify JWT with jose, redirect if invalid. Cheap, no DB.
  - Route handler `app/api/login/route.ts` (Node): `checkPassword` with @node-rs/argon2, then `signSession`. Set cookie.
  - Rate-limit login with Upstash limiter in that route (no Redis in proxy needed).
- Since proxy is Node in Next 16, argon2 would also run there, but keep hashing in the route: it is slow and CPU-bound; proxy runs on every request.

Example proxy:
```ts
// proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const token = req.cookies.get("session")?.value;
  if (!token) return NextResponse.redirect(new URL("/login", req.url));
  try {
    await verifySession(token);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = { matcher: ["/app/:path*"] };
```
UNVERIFIED: `config.matcher` shape in proxy file (carried over from middleware convention; confirm against nextjs.org proxy docs before coding).

---

## 9. Ink, ink-text-input, ink-select-input, Next.js

### Ink 8.0.0 (VERIFIED npm package: ESM, node >=22)
- Requires Node 22+, React 19.3+ (`peerDependencies`). Install `react@^19.3`, `@types/react@^19.3` (types).
- Exports verified in build index: `render`, `renderToString`, `Box`, `Text`, `useInput`, `useApp`.
- Context7 docs are for v7.1.1; v8 behavior beyond exports UNVERIFIED.

```tsx
// src/cli.tsx  (package.json: "type": "module"; tsconfig: "module": "NodeNext", "jsx": "react-jsx")
import React, { useState } from "react";
import { render, Text, useApp, useInput } from "ink";

const App = () => {
  const { exit } = useApp();
  const [n, setN] = useState(0);
  useInput((input, key) => {
    if (input === "q") exit();
    if (key.return) setN((v) => v + 1);
  });
  return <Text>count {n} (enter, q quits)</Text>;
};

render(<App />);
```
- `render()` returns instance synchronously; `useApp().exit()` unmounts.
- Run with `bun` or `tsx` (ESM). Not CJS-compatible.

### ink-text-input 6.0.0 / ink-select-input 6.2.0
- Both ESM (`"type": "module"`), peers `ink >=5`, `react >=18`. Ranges accept ink 8 / react 19.3.
- Runtime compat with ink 8 + React 19.3: UNVERIFIED (no test run). Smoke-test before depending on them. Fallback: write a 20-line `useInput`-based text field (stdlib-first).

### Next.js 16.4.1
- Latest dist-tag: 16.4.1. Node >=20.9.
- `middleware` file renamed `proxy` (see section 8). Canary is 16.5.0-canary.14 (not for use).
- Codemod for rename: `npx @next/codemod@canary middleware-to-proxy .` (DOCS).

---

## UNVERIFIED summary
1. Haiku 5.5 support for forced `tool_choice` (DOCS list omits it; not confirmed).
2. Anthropic SDK error class names (`RateLimitError`, `InternalServerError`) in 0.134.0 d.ts. Not grepped.
3. Workflow default step `maxRetries` value; `extendTimeout` name for Sandbox.
4. Workflow Next.js instrumentation bootstrap need on default world.
5. Exa `startCrawlDate` names; full-ISO timestamp acceptance for date filters.
6. `drizzle-orm/neon-serverless` constructor shape with `Pool`; drizzle migrations table default name.
7. Upstash SDK method name for DELEX (command name confirmed via docs, SDK wrapper not).
8. `argon2` (node-argon2) build on Vercel.
9. `proxy.ts` `config.matcher` exact shape in Next 16.4.
10. ink-text-input / ink-select-input runtime with ink 8 + React 19.3.
11. Ink 8 behavior beyond exported names (docs are v7.1.1).
12. Sandbox timeout maximums: taken from docs page text, not from SDK types.

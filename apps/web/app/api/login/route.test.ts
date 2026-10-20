import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Next's own .env loader (dotenv + dotenv-expand), resolved through next.
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require(require.resolve("@next/env", { paths: [require.resolve("next")] })) as {
  loadEnvConfig: (dir: string, dev: boolean, log: object, forceReload: boolean) => { combinedEnv: Record<string, string> };
};
// One load (the loader caches process.env between calls); `.env` since NODE_ENV=test skips .env.local.
// Fixed argon2id("hunter2"): dotenv-expand leaves `$` + non-word (`$/`, `$+`) unexpanded, so a random
// hash whose digest starts with `/` or `+` (~3%) is NOT mangled. This one is, deterministically.
const raw = "$argon2id$v=19$m=19456,t=2,p=1$FuSmLbmeJcY8vzsBicCiRw$g9Hwh9mPjaXhZjTOrABZMlLLwYZtSaDElayWKjrG6qQ";
let fromEnv: Record<string, string> = {};
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "pm-env-"));
  writeFileSync(join(dir, ".env"), `T6_RAW=${raw}\nT6_ESC=${raw.replaceAll("$", "\\$")}\n`);
  fromEnv = loadEnvConfig(dir, false, { info() {}, error() {} }, true).combinedEnv;
});
let ip = 0;
const login = (password: string) =>
  POST(new Request("http://x/api/login", {
    method: "POST",
    headers: { "x-forwarded-for": `10.0.0.${++ip}` }, // fresh rate-limit bucket per call
    body: JSON.stringify({ password }),
  }));
beforeEach(() => {
  process.env.JWT_SECRET = "x".repeat(32);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("unescaped hash in .env is mangled by dotenv-expand -> 500, not a silent 401", async () => {
  process.env.APP_PASSWORD_HASH = fromEnv.T6_RAW;
  expect(fromEnv.T6_RAW).toBeTruthy();
  expect(fromEnv.T6_RAW).not.toBe(raw); // the bug: dotenv-expand ate `$argon2id`, `$v`, `$m`...
  expect(fromEnv.T6_ESC).toBe(raw);
  expect((await login("hunter2")).status).toBe(500);
});

it("escaped hash in .env logs in; wrong password is 401", async () => {
  process.env.APP_PASSWORD_HASH = fromEnv.T6_ESC;
  const ok = await login("hunter2");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie")).toMatch(/^pm_session=.+HttpOnly/i);
  expect((await login("nope")).status).toBe(401);
});

it("escaped hash read without expansion (e.g. Vercel dashboard) also works", async () => {
  process.env.APP_PASSWORD_HASH = raw.replaceAll("$", "\\$");
  expect((await login("hunter2")).status).toBe(200);
  process.env.APP_PASSWORD_HASH = raw;
  expect((await login("hunter2")).status).toBe(200);
});

it("argon2 verify error is 500 (corrupt but well-prefixed hash)", async () => {
  process.env.APP_PASSWORD_HASH = "$argon2id$garbage";
  expect((await login("hunter2")).status).toBe(500);
});

describe("exponential lockout", () => {
  const MIN = 60_000;
  let n = 0;
  const fresh = () => `10.2.0.${++n}`; // own bucket per test: the kv is a shared singleton
  const attempt = (ip: string, password: string) =>
    POST(new Request("http://x/api/login", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ password }) }));
  const wait = (ms: number) => vi.setSystemTime(Date.now() + ms);
  beforeEach(() => {
    process.env.APP_PASSWORD_HASH = raw;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("locks after 5 consecutive failures, even the right password is refused until the lock ends", async () => {
    const ip = fresh();
    for (let i = 0; i < 5; i++) expect((await attempt(ip, "nope")).status).toBe(401);
    const locked = await attempt(ip, "hunter2");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("900");
    wait(15 * MIN + 1000);
    expect((await attempt(ip, "hunter2")).status).toBe(200);
  });

  it("Retry-After is the remaining lock time", async () => {
    const ip = fresh();
    for (let i = 0; i < 5; i++) await attempt(ip, "nope");
    wait(4 * MIN);
    expect((await attempt(ip, "hunter2")).headers.get("Retry-After")).toBe("660");
  });

  it("doubles per further failure and caps at 24 h", async () => {
    const ip = fresh();
    for (let i = 0; i < 5; i++) await attempt(ip, "nope");
    const want = [15, 30, 60, 120, 240, 480, 960, 1440, 1440].map((m) => String(m * 60));
    for (const s of want) {
      const r = await attempt(ip, "nope");
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toBe(s);
      wait(Number(s) * 1000 + 1000);
      expect((await attempt(ip, "nope")).status).toBe(401); // next failure after the lock ends
    }
  });

  it("a success resets the failure streak", async () => {
    const ip = fresh();
    for (let i = 0; i < 4; i++) await attempt(ip, "nope");
    expect((await attempt(ip, "hunter2")).status).toBe(200);
    wait(16 * MIN);
    for (let i = 0; i < 4; i++) expect((await attempt(ip, "nope")).status).toBe(401);
    expect((await attempt(ip, "nope")).status).toBe(401); // 5th failure of the new streak locks
    expect((await attempt(ip, "hunter2")).status).toBe(429);
  });
});

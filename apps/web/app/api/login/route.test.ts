import { hash } from "@node-rs/argon2";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

// Next's own .env loader (dotenv + dotenv-expand), resolved through next.
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require(require.resolve("@next/env", { paths: [require.resolve("next")] })) as {
  loadEnvConfig: (dir: string, dev: boolean, log: object, forceReload: boolean) => { combinedEnv: Record<string, string> };
};
// One load (the loader caches process.env between calls); `.env` since NODE_ENV=test skips .env.local.
let raw = "";
let fromEnv: Record<string, string> = {};
beforeAll(async () => {
  raw = await hash("hunter2");
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

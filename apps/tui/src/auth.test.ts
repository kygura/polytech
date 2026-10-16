import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authHeaders, loadToken, login, tokenPath } from "./auth";

const HOME = process.env.HOME;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), "pm-auth-"));
});
afterEach(() => {
  process.env.HOME = HOME;
  vi.unstubAllGlobals();
});

it("login refuses plain http to a remote host", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await expect(login("http://example.com", "pw")).rejects.toThrow(/plain http/);
});

it("authHeaders refuses plain http to a remote base", async () => {
  vi.stubEnv("PM_API_BASE", "http://example.com");
  await expect(authHeaders()).rejects.toThrow(/plain http/);
  vi.stubEnv("PM_API_BASE", "http://[::1]:3000");
  await expect(authHeaders()).resolves.toEqual({});
  vi.unstubAllEnvs();
});

it("login stores token with 0600 file / 0700 dir and builds bearer header", async () => {
  const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => Response.json({ ok: true, token: "jwt.abc.def" }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await loadToken()).toBeNull();
  expect(await authHeaders()).toEqual({});

  await login("http://localhost:3000", "pw");
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url.toString()).toBe("http://localhost:3000/api/login");
  expect(new Headers(init?.headers).get("x-client")).toBe("tui");
  expect((await stat(tokenPath())).mode & 0o777).toBe(0o600);
  expect((await stat(join(tokenPath(), ".."))).mode & 0o777).toBe(0o700);
  expect(await authHeaders()).toEqual({ Authorization: "Bearer jwt.abc.def" });

  await login("http://localhost:3000", "pw"); // overwrite works
  expect(await loadToken()).toBe("jwt.abc.def");
});

it("login throws and stores nothing on 401", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid credentials" }, { status: 401 })));
  await expect(login("http://localhost:3000", "bad")).rejects.toThrow("401");
  expect(await loadToken()).toBeNull();
});

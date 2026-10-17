import { memoryKv } from "@pm/db";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "../proxy";
import { checkCron, clientIp, loginRateLimit, safeNext, signSession, verifySession } from "./auth";

const SECRET = "x".repeat(32);
const CRON = "c".repeat(32);
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.CRON_SECRET = CRON;
  delete process.env.VERCEL;
});
const key = (s = SECRET) => new TextEncoder().encode(s);

describe("jwt", () => {
  it("sign/verify roundtrip", async () => {
    expect(await verifySession(await signSession())).toBe(true);
  });
  it("rejects expired", async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("owner")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key());
    expect(await verifySession(t)).toBe(false);
  });
  it("rejects tampered and wrong-key tokens", async () => {
    const t = await signSession();
    const [h, p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "owner", exp: 9999999999 })).toString("base64url");
    expect(await verifySession(`${h}.${forged}.${s}`)).toBe(false);
    expect(await verifySession(`${h}.${p}.${s!.slice(0, -2)}AA`)).toBe(false);
    const other = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("owner")
      .setExpirationTime("1h").sign(key("y".repeat(32)));
    expect(await verifySession(other)).toBe(false);
  });
  it("rejects wrong alg (HS512, none)", async () => {
    const hs512 = await new SignJWT({}).setProtectedHeader({ alg: "HS512" }).setSubject("owner")
      .setExpirationTime("1h").sign(key("x".repeat(64)));
    expect(await verifySession(hs512)).toBe(false);
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(await verifySession(`${b({ alg: "none" })}.${b({ sub: "owner", exp: 9999999999 })}.`)).toBe(false);
  });
  it("rejects token without exp", async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("owner").sign(key());
    expect(await verifySession(t)).toBe(false);
  });
  it("fails closed on missing/short JWT_SECRET", async () => {
    const t = await signSession();
    process.env.JWT_SECRET = "short";
    expect(await verifySession(t)).toBe(false);
    await expect(signSession()).rejects.toThrow();
    delete process.env.JWT_SECRET;
    expect(await verifySession(t)).toBe(false);
  });
});

describe("safeNext", () => {
  it.each(["//evil.com", "https://evil", "/\\evil", "\\\\evil", "evil", "/\t/evil.com", "", null])("rejects %j", (v) => {
    expect(safeNext(v)).toBe("/");
  });
  it("keeps relative paths", () => {
    expect(safeNext("/markets/abc?tab=1")).toBe("/markets/abc?tab=1");
  });
});

describe("login rate limit", () => {
  it("blocks the 6th attempt per IP", async () => {
    const kv = memoryKv();
    for (let i = 0; i < 5; i++) expect((await loginRateLimit(kv, "1.2.3.4")).ok).toBe(true);
    expect((await loginRateLimit(kv, "1.2.3.4")).ok).toBe(false);
    expect((await loginRateLimit(kv, "5.6.7.8")).ok).toBe(true);
  });
  it("self-hosted: x-real-ip, else rightmost xff hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("2.2.2.2"); // spoofed x-real-ip ignored
    expect(clientIp(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers())).toBe("unknown");
  });
  it("vercel: first xff hop", () => {
    process.env.VERCEL = "1";
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
  });
  it("unknown ip gets a high shared limit, not 5", async () => {
    const kv = memoryKv();
    for (let i = 0; i < 50; i++) expect((await loginRateLimit(kv, "unknown")).ok).toBe(true);
    expect((await loginRateLimit(kv, "unknown")).ok).toBe(false);
  });
});

describe("cron bearer", () => {
  it("rejects a secret shorter than 32 bytes", () => {
    expect(checkCron("Bearer short", "short")).toBe(false);
  });
  it("checks constant-time and fails closed", () => {
    expect(checkCron(`Bearer ${CRON}`)).toBe(true);
    expect(checkCron("Bearer wrong")).toBe(false);
    expect(checkCron(null)).toBe(false);
    expect(checkCron("Bearer ", "")).toBe(false);
    expect(checkCron("Bearer undefined", undefined)).toBe(false);
  });
});

describe("proxy", () => {
  const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, { headers });

  it("allows public paths", async () => {
    for (const p of ["/login", "/api/login"]) expect((await proxy(req(p))).headers.get("x-middleware-next")).toBe("1");
  });
  it("exempts only the proposal push route from session auth", async () => {
    expect((await proxy(req("/api/proposals/abc/push"))).headers.get("x-middleware-next")).toBe("1");
    for (const p of ["/api/proposals", "/api/proposals/abc", "/api/proposals/abc/push/x", "/api/proposals/a/b/push"]) expect((await proxy(req(p))).status).toBe(401);
  });
  it("self-hosted: workflow routes stay guarded", async () => {
    expect((await proxy(req("/.well-known/workflow/v1/flow"))).status).toBe(307);
  });
  it("vercel: lets workflow runtime routes through, nothing else under .well-known", async () => {
    process.env.VERCEL = "1";
    for (const p of ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/step", "/.well-known/workflow/v1/webhook/t"]) {
      expect((await proxy(req(p))).headers.get("x-middleware-next")).toBe("1");
    }
    expect((await proxy(req("/.well-known/workflowx"))).status).toBe(307);
    expect((await proxy(req("/.well-known/other"))).status).toBe(307);
  });
  it("redirects unauthed pages with next", async () => {
    const r = await proxy(req("/markets?x=1"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://localhost/login?next=%2Fmarkets%3Fx%3D1");
  });
  it("401s unauthed api", async () => {
    expect((await proxy(req("/api/watchlist"))).status).toBe(401);
  });
  it("accepts cookie or bearer", async () => {
    const t = await signSession();
    expect((await proxy(req("/api/x", { cookie: `pm_session=${t}` }))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(req("/", { authorization: `Bearer ${t}` }))).headers.get("x-middleware-next")).toBe("1");
  });
  it("cron needs CRON_SECRET, not a session", async () => {
    const t = await signSession();
    expect((await proxy(req("/api/cron/sweep", { authorization: `Bearer ${t}` }))).status).toBe(401);
    expect((await proxy(req("/api/cron/sweep", { authorization: `Bearer ${CRON}` }))).headers.get("x-middleware-next")).toBe("1");
    delete process.env.CRON_SECRET;
    expect((await proxy(req("/api/cron/sweep", { authorization: "Bearer undefined" }))).status).toBe(401);
  });
});

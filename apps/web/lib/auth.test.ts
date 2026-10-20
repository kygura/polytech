import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "../proxy";
import { checkCron, clientIp } from "./auth";

const CRON = "c".repeat(32);
beforeEach(() => {
  process.env.CRON_SECRET = CRON;
  delete process.env.VERCEL;
});

describe("clientIp", () => {
  it("self-hosted: x-real-ip, else rightmost xff hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("2.2.2.2"); // spoofed x-real-ip ignored
    expect(clientIp(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers())).toBe("unknown");
  });
  it("vercel: first xff hop", () => {
    process.env.VERCEL = "1";
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
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
  const req = (path: string, method = "GET", headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { method, headers });
  const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

  it("no login: pages, api and push routes pass without credentials", () => {
    for (const p of ["/", "/markets", "/trade", "/trade/0xabc", "/api/settings", "/api/watchlist", "/api/proposals/abc/push", "/api/sets/abc/push", "/.well-known/workflow/v1/flow"]) expect(passes(proxy(req(p))), p).toBe(true);
  });
  it("/login is gone: no redirect to it", () => {
    expect(proxy(req("/markets")).headers.get("location")).toBeNull();
  });
  it("cron needs CRON_SECRET", () => {
    expect(proxy(req("/api/cron/sweep")).status).toBe(401);
    expect(proxy(req("/api/cron/sweep", "GET", { authorization: "Bearer nope" })).status).toBe(401);
    expect(passes(proxy(req("/api/cron/sweep", "GET", { authorization: `Bearer ${CRON}` })))).toBe(true);
    delete process.env.CRON_SECRET;
    expect(proxy(req("/api/cron/sweep", "GET", { authorization: "Bearer undefined" })).status).toBe(401);
  });
  it("/api/public/* is GET/HEAD only", () => {
    for (const m of ["GET", "HEAD"]) expect(passes(proxy(req("/api/public/watchlist", m)))).toBe(true);
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect(proxy(req("/api/public/watchlist", m)).status).toBe(405);
  });
});

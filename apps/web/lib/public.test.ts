import { memoryKv } from "@pm/db";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "../proxy";
import { signSession } from "./auth";
import { publicLimit, publicMarketDetail, publicWatchRow } from "./public";

/** Every key at any depth. */
const deepKeys = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => deepKeys(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) out.add(k), deepKeys(v, out);
  return out;
};
const FORBIDDEN = ["pinned", "muted", "sizeUsd", "shares", "expectedProfit", "rank", "k", "e", "r", "payoff", "positions", "pod", "podId", "usage", "costUsd", "model", "durationS", "trigger", "roleMix", "judgeConfidence", "researching"];
const noForbidden = (x: unknown) => expect([...deepKeys(x)].filter((k) => FORBIDDEN.includes(k))).toEqual([]);

const struct = { type: "neg-risk-sum" as const, kind: "buy-all" as const, lockedC: 2, sum: 0.97, legs: ["a", "b"], sizeUsd: 50 };

describe("projection", () => {
  it("watch row: allowlist only", () => {
    const row = {
      conditionId: "c", question: "q", category: "politics", tier: "small-cap", pinned: true, muted: false, shortlisted: true, researching: true,
      priority: 1, midNow: 0.4, daysLeft: 9, endDate: 1, thesisId: "t", thesisAgeH: 2, expired: false, capped: false, nextCatalyst: null,
      structural: struct, side: "YES", pMid: 0.4, pHat: 0.5, c: 0.3, pPost: 0.43, k: 0.41, e: 0.02, edgeC: 2, r: 0.05, payoff: 1, rAnn: 0.3,
      sizeUsd: 100, shares: 200, expectedProfit: 4, rank: 7,
    } as never;
    const p = publicWatchRow(row);
    expect(Object.keys(p).sort()).toEqual(["c", "capped", "category", "conditionId", "daysLeft", "edgeC", "endDate", "expired", "midNow", "nextCatalyst", "pHat", "pMid", "pPost", "priority", "question", "rAnn", "research", "shortlisted", "side", "structural", "thesisAgeH", "thesisId", "tier"]);
    expect(p.research).toBe("done");
    const fresh = { ...(row as object), thesisId: null } as never;
    expect(publicWatchRow(fresh).research).toBe("researching");
    expect(publicWatchRow(fresh, true).research).toBe("disabled");
    expect(publicWatchRow({ ...(fresh as object), researching: false } as never).research).toBe("pending");
    expect(p.structural).toEqual({ type: "neg-risk-sum", kind: "buy-all", lockedC: 2, sum: 0.97, legs: ["a", "b"] });
    noForbidden(p);
  });

  it("market detail: allowlist only, deep", () => {
    const d = {
      market: { conditionId: "c", question: "q", rules: "r", category: "crypto", tags: [], eventId: "ev", negRiskGroup: "g", endDate: 1, daysLeft: 3, feeRate: null, status: "active", yesTokenId: "y", noTokenId: "n", pinned: true, muted: true },
      snapshot: { ts: 1, mid: 0.5, bestBid: 0.49, bestAsk: 0.51, depth5cUsd: 100, vol24h: 1, oi: 1, top10Share: 0.2, bids: [{ price: 0.49, size: 10 }], asks: [{ price: 0.51, size: 10 }], netFlow: 0 },
      history: [{ ts: 1, mid: 0.5 }],
      screen: { ts: 1, R: 1, I: 1, L: 1, T: 1, C: 1, priority: 1, tier: "size", structural: struct },
      thesis: { id: "t", podId: "p", createdAt: 1, expiresAt: 2, side: "NO", pHat: 0.6, c: 0.3, pPost: 0.55, edgeC: 3, sizeUsd: 10, rAnn: 1, rank: 2, catalysts: [], killCriteria: [], thesis: "text", pYes: 0.4, pMidYes: 0.5, k: 1, e: 1, shares: 1, payoff: 1, expectedProfit: 1, capped: false, judgeConfidence: 0.7, trigger: "manual", model: "m", roleMix: "a+b", daysLeft: 3 },
      thesisMarkers: [{ createdAt: 1, pHat: 0.6, side: "NO" }],
      evidence: [{ id: 1, role: "news", claim: "c", quote: "q", url: "u", direction: 1, publishedAt: null, retrievedAt: 1 }],
      agents: [{ role: "news", model: "m", status: "ok", probability: 0.4, confidence: 0.5, durationS: 3, usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 } }],
      pod: { id: "p", status: "done", trigger: "manual", startedAt: 1 },
      positions: [{ id: 1, tokenId: "y", size: 1, avgCost: 1, realizedPnl: 0, openedAt: 1, closedAt: null }],
    } as never;
    const p = publicMarketDetail(d);
    expect(Object.keys(p).sort()).toEqual(["agents", "evidence", "history", "market", "research", "screen", "snapshot", "thesis", "thesisMarkers"]);
    noForbidden(p);
    expect(p.market).toMatchObject({ feeRate: expect.any(Number), negRisk: true, yesTokenId: "y", noTokenId: "n", eventId: "ev", category: "crypto" });
    expect(p.thesis).toMatchObject({ pYes: 0.4, c: 0.3, side: "NO", capped: false, thesis: "text" });
    expect(p.research).toBe("done");
    expect(p.agents[0]).toEqual({ role: "news", status: "ok", probability: 0.4, confidence: 0.5 });
  });
});

describe("public rate limit", () => {
  it("60/min per IP, then 429 + Retry-After; other IPs unaffected", async () => {
    const kv = memoryKv(), req = (ip: string) => new Request("http://x/api/public/watchlist", { headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 60; i++) expect(await publicLimit(req("1.1.1.1"), kv)).toBeNull();
    const r = (await publicLimit(req("1.1.1.1"), kv))!;
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await publicLimit(req("2.2.2.2"), kv)).toBeNull();
  });
});

describe("proxy: public boundary", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "x".repeat(32);
    delete process.env.VERCEL;
  });
  const req = (path: string, method = "GET", headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { method, headers });
  const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

  it("anon GET/HEAD /api/public/* pass; other methods 405", async () => {
    for (const p of ["/api/public/watchlist", "/api/public/markets/0xabc"]) {
      expect(passes(await proxy(req(p)))).toBe(true);
      expect(passes(await proxy(req(p, "HEAD")))).toBe(true);
    }
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect((await proxy(req("/api/public/watchlist", m))).status).toBe(405);
  });
  it("/trade pages public; nothing else", async () => {
    for (const p of ["/trade", "/trade/0xabc"]) expect(passes(await proxy(req(p)))).toBe(true);
    for (const p of ["/trader", "/tradex/1"]) expect((await proxy(req(p))).status).toBe(307);
    for (const p of ["/api/settings", "/api/watchlist", "/api/public", "/api/publicx/watchlist", "/api/markets/0xabc", "/api/autonomy"]) expect((await proxy(req(p))).status).toBe(401);
    const r = await proxy(req("/autonomy"));
    expect(r.headers.get("location")).toBe("http://localhost/login?next=%2Fautonomy");
  });
  it("/: anon -> /trade, operator unchanged", async () => {
    const r = await proxy(req("/"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://localhost/trade");
    expect(passes(await proxy(req("/", "GET", { cookie: `pm_session=${await signSession()}` })))).toBe(true);
  });
});

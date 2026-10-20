import { beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
process.env.PM_FIXTURES = "1";
delete process.env.ANTHROPIC_API_KEY;

let GET: typeof import("./markets/[id]/history/route").GET, NOW = 0;
const call = (id: string, qs = "") => GET(new Request(`http://x/api/markets/${id}/history${qs}`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  const a = await import("../../lib/api"), { schema: S } = await import("@pm/db");
  const d = await a.getDeps();
  NOW = d.now();
  await d.db.insert(S.markets).values({ conditionId: "0xh", question: "q?", yesTokenId: "no-such-token" });
  // 700 own snapshots over the last 3 days (fixtures have no history for this token, so the fallback serves them)
  await d.db.insert(S.snapshots).values(Array.from({ length: 700 }, (_, i) => ({ conditionId: "0xh", ts: new Date(NOW - 3 * 864e5 + i * 370_000), mid: 0.4 + (i % 10) / 100 })));
  ({ GET } = await import("./markets/[id]/history/route"));
});

describe("GET /api/markets/[id]/history", () => {
  it("400 on a bad range, 404 on an unknown market", async () => {
    expect((await call("0xh", "?range=1y")).status).toBe(400);
    expect((await call("0xnope")).status).toBe(404);
  });
  it("falls back to own snapshots, windowed to the range, <= 500 points, CDN cacheable", async () => {
    const day = await call("0xh", "?range=1d");
    expect(day.status).toBe(200);
    expect(day.headers.get("cache-control")).toBe("public, s-maxage=60");
    const j = await day.json();
    expect(j).toMatchObject({ range: "1d", source: "snapshots" });
    expect(j.points.length).toBeGreaterThan(0);
    expect(j.points.every((p: { ts: number }) => p.ts >= NOW - 864e5)).toBe(true);
    const all = await (await call("0xh", "?range=all")).json();
    expect(all.points.length).toBeLessThanOrEqual(500);
    expect(all.points.length).toBeGreaterThan(j.points.length);
  });
  it("defaults to 1m", async () => {
    expect((await (await call("0xh")).json()).range).toBe("1m");
  });
});

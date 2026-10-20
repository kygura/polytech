import { schema as s } from "@pm/db";
import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import { getDeps, json, notFound } from "../../../../../lib/api";
import { DEFAULT_RANGE, historyCache, loadHistory, parseRange } from "../../../../../lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = "public, s-maxage=60";
const SNAP_LIMIT = 20_000; // rows read for the fallback before downsampling

/** DESIGN 12.6.2: YES price history for ?range=1d|1w|1m|all (default 1m), <= 500 points, 60 s memo + CDN cache. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("range");
  const range = raw == null ? DEFAULT_RANGE : parseRange(raw);
  if (!range) return json({ error: "range must be 1d, 1w, 1m or all" }, 400);
  const d = await getDeps();
  const m = (await d.db.select({ yes: s.markets.yesTokenId }).from(s.markets).where(eq(s.markets.conditionId, id)))[0];
  if (!m) return notFound();
  const r = await historyCache.get(`${id}|${range}`, () => loadHistory(range, {
    tokenId: m.yes, pm: d.pm, now: d.now(),
    snapshots: async (since) =>
      (await d.db.select({ ts: s.snapshots.ts, mid: s.snapshots.mid }).from(s.snapshots)
        .where(and(eq(s.snapshots.conditionId, id), gte(s.snapshots.ts, new Date(since)), isNotNull(s.snapshots.mid)))
        .orderBy(asc(s.snapshots.ts)).limit(SNAP_LIMIT)).map((x) => ({ ts: x.ts.getTime(), mid: x.mid! })),
  }));
  return Response.json(r, { headers: { "cache-control": CACHE } });
}

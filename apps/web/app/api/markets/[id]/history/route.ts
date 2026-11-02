import type { Db } from "@pm/db";
import { getDeps, json, notFound } from "../../../../../lib/api";
import { DEFAULT_RANGE, historyCache, loadHistory, parseRange } from "../../../../../lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = "public, s-maxage=60";
const SNAP_LIMIT = 20_000; // rows read for the fallback before downsampling

/** ts >= since and mid not null, oldest first, first SNAP_LIMIT rows (the condMid index holds only rows with a mid). */
const oldestMids = async (db: Db, conditionId: string, since: number) =>
  (await db.snapshots.findFields("condMid", { conditionId }, ["ts", "mid"] as const, { min: since, order: "asc", limit: SNAP_LIMIT })).map((x) => ({ ts: x.ts.getTime(), mid: x.mid! }));

/** DESIGN 12.6.2: YES price history for ?range=1d|1w|1m|all (default 1m), <= 500 points, 60 s memo + CDN cache. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("range");
  const range = raw == null ? DEFAULT_RANGE : parseRange(raw);
  if (!range) return json({ error: "range must be 1d, 1w, 1m or all" }, 400);
  const d = await getDeps();
  const row = await d.db.markets.get(id);
  if (!row) return notFound();
  const m = { yes: row.yesTokenId };
  const r = await historyCache.get(`${id}|${range}`, () => loadHistory(range, {
    tokenId: m.yes, pm: d.pm, now: d.now(),
    snapshots: (since) => oldestMids(d.db, id, since),
  }));
  return Response.json(r, { headers: { "cache-control": CACHE } });
}

import { getDeps, json, notFound } from "../../../../../../lib/api";
import { marketFeed } from "../../../../../../lib/feed";
import { publicFeedLimit } from "../../../../../../lib/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 2 s CDN cache: concurrent visitors of one market share one upstream fetch, on any instance.
const CACHE = "public, s-maxage=2, stale-while-revalidate=4";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await publicFeedLimit(req);
  if (limited) return limited;
  const d = await getDeps();
  const row = await d.db.markets.get((await params).id);
  const m = row && { conditionId: row.conditionId, yesTokenId: row.yesTokenId, tickSize: row.tickSize };
  if (!m?.yesTokenId) return notFound();
  const feed = await marketFeed(d.pm, { ...m, yesTokenId: m.yesTokenId }, d.now()).catch((e) => {
    console.error(`feed ${m.conditionId}:`, e instanceof Error ? e.message : e);
    return undefined;
  });
  if (feed === undefined) return json({ error: "venue unavailable" }, 502);
  return feed ? Response.json(feed, { headers: { "cache-control": CACHE } }) : notFound();
}

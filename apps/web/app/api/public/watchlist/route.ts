import { getKv } from "@pm/db";
import { after } from "next/server";
import { getRead } from "../../../../lib/api";
import { read } from "../../../../lib/jobs";
import { kickIfStale } from "../../../../lib/jobs/kick";
import { freshness, publicJson, publicLimit, publicWatchRow, researchDisabled, type PublicWatchlist } from "../../../../lib/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the inline (non-Vercel) scouting chain runs in after()

// Anonymous watchlist: thesis list of both tiers (no structural tab), muted rows hidden, projected, with data freshness.
// A read also kicks stale scouting, never in the response path.
export async function GET(req: Request) {
  const limited = await publicLimit(req);
  if (limited) return limited;
  after(() => kickIfStale().catch((e) => console.error("scouting kick failed", e)));
  const r = await getRead(), disabled = await researchDisabled();
  const [small, size, fresh] = await Promise.all([read.watchlist(r, "small-cap"), read.watchlist(r, "size"), freshness(r.db, getKv(), r.now())]);
  const body: PublicWatchlist = { ...fresh, research: disabled ? "disabled" : "on", rows: [...small, ...size].map((x) => publicWatchRow(x, disabled)) };
  return publicJson(body);
}

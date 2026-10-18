import { after } from "next/server";
import { getDeps, json, notFound } from "../../../../../../lib/api";
import { getProfile, matchMarkets, runProfile } from "../../../../../../lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

// Run the profile now: match, answer 202 with the queued ids, run the pods after the response (budget + per-market locks apply).
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const d = await getDeps(), p = await getProfile(d.db, (await params).id);
  if (!p) return notFound();
  const matches = await matchMarkets(d.db, p.filter, d.now());
  after(() => runProfile(d, p, matches).catch((e) => console.error("profile run failed", p.id, e)));
  return json({ queued: matches.map((m) => m.conditionId) }, 202);
}

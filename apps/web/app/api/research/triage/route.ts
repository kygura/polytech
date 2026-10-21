import { z } from "zod";
import { getDeps, json, parseBody } from "../../../../lib/api";
import { TRIAGE_MAX, triageMarkets, triageOf } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ID = /^0x[0-9a-fA-F]{64}$/;
const Body = z.strictObject({ ids: z.array(z.string().regex(ID)).min(1).max(TRIAGE_MAX), force: z.boolean().optional() });

/** Stored verdicts for ?ids=a,b (no model calls). */
export async function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((x) => ID.test(x)).slice(0, 200);
  const d = await getDeps();
  return json([...(await triageOf(d.db, ids)).values()]);
}

/** Triage up to 50 markets: primitive rules, then one cheap model call for each market that passes. */
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  try {
    return json(await triageMarkets(await getDeps(), b.data.ids, { force: b.data.force }));
  } catch (e) {
    console.error("triage failed", e);
    return json({ error: `triage failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
}

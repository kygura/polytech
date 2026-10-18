import { z } from "zod";
import { getDeps, json, parseBody } from "../../../../lib/api";
import { ingestMarket } from "../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.strictObject({ id: z.string().trim().min(1).max(100) });

// Upserts a picked market (and snapshots its book); the client then calls POST /api/markets/:conditionId/research.
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  try {
    const r = await ingestMarket(await getDeps(), b.data.id);
    return r ? json(r) : json({ error: "market not found, closed, not accepting orders or expired" }, 404);
  } catch (e) {
    console.error("market ingest failed", b.data.id, e);
    return json({ error: "ingest failed" }, 502);
  }
}

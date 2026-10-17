import { z } from "zod";
import { getDeps, json, parseBody } from "../../../../lib/api";
import { rebaseline } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ ack: z.boolean().optional() }).optional(); // no body = {}

// session-authenticated by proxy.ts (not in its public list)
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const r = await rebaseline(await getDeps(), { ack: b.data?.ack === true });
  return r.ok ? json(r) : json({ error: r.error, needsAck: r.code === "FAILED_UNKNOWN", diff: r.diff }, 409);
}

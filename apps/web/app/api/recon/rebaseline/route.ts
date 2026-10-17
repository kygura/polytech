import { getDeps, json } from "../../../../lib/api";
import { rebaseline } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// session-authenticated by proxy.ts (not in its public list)
export async function POST() {
  const r = await rebaseline(await getDeps());
  return r.ok ? json(r) : json({ error: r.error }, 409);
}

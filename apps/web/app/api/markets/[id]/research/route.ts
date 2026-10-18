import { after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_STEERING, SteeringSchema, SteeringShape } from "@pm/core";
import { schema as s } from "@pm/db";
import { getDeps, json, notFound, parse } from "../../../../../lib/api";
import { getProfile, researchMarket } from "../../../../../lib/jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

const SKIP_WINDOW_MS = 3000;
const Body = z.strictObject({ profileId: z.string().optional(), steering: SteeringShape.partial().optional() });

// A pod takes minutes: answer 202 now, run after the response. researchMarket locks per market itself.
// Body optional: empty = old behavior. Else steering = (profile.steering | default) shallow-merged with the override, re-validated.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id, d = await getDeps();
  if (!(await d.db.select({ id: s.markets.conditionId }).from(s.markets).where(eq(s.markets.conditionId, id)))[0]) return notFound();
  const text = await req.text();
  let opts: { steering?: z.infer<typeof SteeringSchema>; profileId?: string } = {};
  if (text.trim()) {
    const b = parse(Body, (() => { try { return JSON.parse(text); } catch { return undefined; } })());
    if (b.res) return b.res;
    const { profileId, steering: over } = b.data;
    if (profileId || over) {
      const profile = profileId ? await getProfile(d.db, profileId) : null;
      if (profileId && !profile) return notFound();
      const m = parse(SteeringSchema, { ...(profile?.steering ?? DEFAULT_STEERING), ...over });
      if (m.res) return m.res;
      opts = { steering: m.data, profileId };
    }
  }
  const run = researchMarket(d, id, "manual", opts);
  after(() => run.catch((e) => console.error("research failed", id, e)));
  // Skips (LOCKED, NO_BOOK, budget, RESEARCH_DISABLED) resolve within moments; a real pod runs for minutes. Wait briefly so a skip reaches the caller instead of vanishing.
  const early = await Promise.race([run.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, SKIP_WINDOW_MS))]);
  if (early && "skipped" in early) return json({ error: `research not started: ${early.reason}`, reason: early.reason }, 409);
  return json({ started: true, conditionId: id }, 202);
}

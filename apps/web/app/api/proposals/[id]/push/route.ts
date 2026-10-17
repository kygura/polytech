import { getKv } from "@pm/db";
import { z } from "zod";
import { getDeps, json } from "../../../../../lib/api";
import { clientIp } from "../../../../../lib/auth";
import { decide } from "../../../../../lib/jobs";

export const runtime = "nodejs";

const PUSH_LIMIT = 20, PUSH_WINDOW_MS = 15 * 60_000;
const Body = z.object({ action: z.enum(["approve", "reject"]), token: z.string().min(1).max(100) });
const invalid = () => json({ error: "invalid" }, 403);

// The only session-exempt API route (proxy.ts). Authority = the single-use token from the ntfy action body.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = clientIp(req.headers);
  if (!(await getKv().rateLimit(`push:${ip}`, ip === "unknown" ? 100 : PUSH_LIMIT, PUSH_WINDOW_MS)).ok) return json({ error: "too many attempts" }, 429);
  const id = (await params).id;
  const b = Body.safeParse(await req.json().catch(() => undefined));
  if (!z.uuid().safeParse(id).success || !b.success) return invalid();
  const r = await decide(await getDeps(), id, b.data.action, "push", b.data.token);
  if (!r.ok) return r.error === "INVALID_TOKEN" || r.error === "NOT_FOUND" ? invalid() : json({ error: "refused" }, 409);
  return json({ state: r.state });
}

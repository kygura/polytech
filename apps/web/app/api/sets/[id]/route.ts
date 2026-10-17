import { z } from "zod";
import { getDeps, json, notFound, parseBody } from "../../../../lib/api";
import { decideSet } from "../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["approve", "reject"]), via: z.enum(["web", "tui"]).default("web") });

// Session-authenticated (proxy.ts). Approve/reject a whole neg-risk set.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!z.uuid().safeParse(id).success) return notFound();
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const r = await decideSet(await getDeps(), id, b.data.action, b.data.via);
  return r.ok ? json(r) : json({ error: r.error }, r.error === "NOT_FOUND" ? 404 : 409);
}

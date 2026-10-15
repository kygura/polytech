import { getDeps, json, notFound } from "../../../../../lib/api";
import { closePaperPosition } from "../../../../../lib/jobs";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ positionId: string }> }) {
  const id = Number((await params).positionId);
  if (!Number.isInteger(id)) return notFound();
  const r = await closePaperPosition(await getDeps(), id);
  if (r === null) return notFound();
  return "reason" in r ? json({ error: r.reason }, 409) : json(r);
}

import { z } from "zod";
import { getDeps, json, notFound } from "../../../../../lib/api";
import { ackSet } from "../../../../../lib/jobs";

export const runtime = "nodejs";

// Session-authenticated (proxy.ts). flagged -> acknowledged; closes nothing.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!z.uuid().safeParse(id).success) return notFound();
  const r = await ackSet(await getDeps(), id);
  return r.ok ? json(r) : json({ error: r.error }, r.error === "NOT_FOUND" ? 404 : 409);
}

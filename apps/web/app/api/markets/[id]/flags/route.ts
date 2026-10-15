import { z } from "zod";
import { getDeps, json, notFound, parseBody } from "../../../../../lib/api";
import { read } from "../../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const d = await getDeps(), id = (await params).id;
  if (!(await read.marketDetail({ db: d.db, now: d.now }, id))) return notFound();
  await read.setFlag(d, id, b.data);
  return json({ ok: true });
}

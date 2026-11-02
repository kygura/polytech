import { z } from "zod";
import { getDeps, json, notFound, parseBody } from "../../../../../lib/api";
import { read } from "../../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  const d = await getDeps(), id = (await params).id;
  if (!(await d.db.markets.get(id))) return notFound(); // existence only: marketDetail would read the whole market page
  await read.setFlag(d, id, b.data);
  return json({ ok: true });
}

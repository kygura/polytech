import { z } from "zod";
import { getRead, json, parse } from "../../../lib/api";
import { terminal } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({ category: z.string().optional(), model: z.string().optional(), days: z.coerce.number().positive().max(3650).optional() });

export async function GET(req: Request) {
  const q = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
  return q.res ?? json(await terminal.journalView(await getRead(), q.data));
}

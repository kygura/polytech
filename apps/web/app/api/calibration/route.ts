import { z } from "zod";
import { getRead, json, parse } from "../../../lib/api";
import { read } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({ category: z.string().optional(), model: z.string().optional(), sinceDays: z.coerce.number().positive().optional() });

export async function GET(req: Request) {
  const q = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
  return q.res ?? json(await read.calibration(await getRead(), q.data));
}

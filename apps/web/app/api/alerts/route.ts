import { z } from "zod";
import { getRead, json, parse } from "../../../lib/api";
import { terminal } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({ unacked: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function GET(req: Request) {
  const q = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
  return q.res ?? json(await terminal.alertsList(await getRead(), { unacked: q.data.unacked === "1", limit: q.data.limit }));
}

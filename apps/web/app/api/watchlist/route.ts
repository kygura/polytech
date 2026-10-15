import { z } from "zod";
import { getRead, json, parse } from "../../../lib/api";
import { read } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({
  tab: z.enum(["small-cap", "size", "structural"]).default("small-cap"),
  sort: z.enum(["rank", "edge", "r_ann", "days"]).optional(),
  muted: z.enum(["1", "0"]).optional(),
});

export async function GET(req: Request) {
  const q = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
  if (q.res) return q.res;
  const { tab, sort, muted } = q.data, r = await getRead(), o = { includeMuted: muted === "1" };
  return json(tab === "structural" ? await read.watchlist(r, tab, sort, o) : await read.watchlist(r, tab, sort, o));
}

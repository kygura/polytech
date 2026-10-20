import { FilterSchema, formatQuery, parseQuery, type Filter } from "@pm/core";
import { z } from "zod";
import { getRead, json, parse } from "../../../lib/api";
import { listMarkets } from "../../../lib/jobs/markets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Q = z.object({
  q: z.string().max(2000).optional(),
  filter: z.string().max(10_000).optional(), // FilterSchema JSON
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Auth: proxy.ts guards every /api route that is not explicitly public.
export async function GET(req: Request) {
  const p = parse(Q, Object.fromEntries(new URL(req.url).searchParams));
  if (p.res) return p.res;
  const { q, filter: raw, limit, offset } = p.data;
  if (q !== undefined && raw !== undefined) return json({ error: "pass q or filter, not both" }, 400);
  let filter: Filter;
  if (raw !== undefined) {
    const f = FilterSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return undefined; } })());
    if (!f.success) return json({ error: "invalid", issues: f.error.issues }, 400);
    filter = f.data;
  } else {
    const r = parseQuery(q ?? "");
    if (r.errors.length) return json({ error: "invalid query", errors: r.errors }, 400);
    filter = r.filter;
  }
  const r = await getRead();
  return json({ ...(await listMarkets(r.db, filter, r.now(), { limit, offset })), query: formatQuery(filter) });
}

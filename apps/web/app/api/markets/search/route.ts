import { z } from "zod";
import { getDeps, json, parse } from "../../../../lib/api";

export const runtime = "nodejs";

const Q = z.string().trim().min(2).max(100);
const SLUG = /polymarket\.com\/(?:event|market)\/([^/?#]+)/i;

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// Auth: proxy.ts guards every /api route that is not explicitly public.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("q") ?? "";
  const p = parse(Q, raw);
  if (p.res) return p.res;
  const slug = SLUG.exec(p.data)?.[1]; // pasted URL -> its slug as words
  const q = slug ? decode(slug).replace(/-+/g, " ") : p.data;
  try {
    const ms = await (await getDeps()).pm.searchMarkets(q, 10);
    return json(ms.map((m) => ({ id: m.id, question: m.question, price: m.yes_price ?? null, liquidity: m.liquidity ?? null, endDate: m.end_date ?? null })));
  } catch (e) {
    console.error("market search failed", e);
    return json({ error: "search unavailable" }, 502);
  }
}

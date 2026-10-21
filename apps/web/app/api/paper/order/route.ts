import { z } from "zod";
import { getDeps, json, parseBody } from "../../../../lib/api";
import { placePaperOrder } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.strictObject({
  conditionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  outcome: z.enum(["YES", "NO"]),
  side: z.enum(["BUY", "SELL"]),
  usd: z.number().positive().max(1_000_000).optional(),
  shares: z.number().positive().max(10_000_000).optional(),
  limit: z.number().gt(0).lt(1).optional(),
});

// Manual paper trade: fills against the live book into the paper book. No wallet, no real money.
export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  if (b.res) return b.res;
  try {
    const r = await placePaperOrder(await getDeps(), b.data);
    return r.ok ? json(r) : json({ error: r.error }, 409);
  } catch (e) {
    console.error("paper order failed", e);
    return json({ error: "paper order failed" }, 502);
  }
}

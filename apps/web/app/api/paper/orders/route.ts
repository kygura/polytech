import { getDeps, json } from "../../../../lib/api";
import { listPaperOrders, withLock, workPaperOrders } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^0x[0-9a-fA-F]{64}$/;

// Resting paper limits and stops. With ?conditionId= the market's working orders are first worked against a fresh book (the ticket polls
// this while one rests). One worker at a time (the snapshot job takes the same lock): two at once could both fill against the same book.
export async function GET(req: Request) {
  const c = new URL(req.url).searchParams.get("conditionId");
  if (c != null && !ID.test(c)) return json({ error: "bad conditionId" }, 400);
  const d = await getDeps();
  if (c) await withLock(d, "paperwork", 60_000, () => workPaperOrders(d, [c], { snapshot: true })).catch((e) => console.error("paper orders: work failed", e));
  return json(await listPaperOrders(d, c ?? undefined));
}

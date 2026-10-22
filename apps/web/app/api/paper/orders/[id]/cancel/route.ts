import { getDeps, json, notFound } from "../../../../../../lib/api";
import { cancelPaperOrder } from "../../../../../../lib/jobs";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!/^pord_[\w-]{1,40}$/.test(id)) return notFound();
  return (await cancelPaperOrder(await getDeps(), id)) ? json({ ok: true }) : json({ error: "order is not working" }, 409);
}

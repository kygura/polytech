import { getRead, json, notFound } from "../../../../lib/api";
import { read } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const m = await read.marketDetail(await getRead(), (await params).id);
  return m ? json(m) : notFound();
}

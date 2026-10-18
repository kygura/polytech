import { getRead, notFound } from "../../../../../lib/api";
import { read } from "../../../../../lib/jobs";
import { publicJson, publicLimit, publicMarketDetail, researchDisabled } from "../../../../../lib/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await publicLimit(req);
  if (limited) return limited;
  const m = await read.marketDetail(await getRead(), (await params).id);
  return m ? publicJson(publicMarketDetail(m, await researchDisabled())) : notFound();
}

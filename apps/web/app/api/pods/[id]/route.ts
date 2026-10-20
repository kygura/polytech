import { getRead, json, notFound } from "../../../../lib/api";
import { read } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** { pod (stage, cost), agents (rows incl. toolCalls), evidence, thesis | null, budget }. Session-gated by proxy.ts like every /api route. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await read.podDetail(await getRead(), (await params).id);
  return r ? json(r) : notFound();
}

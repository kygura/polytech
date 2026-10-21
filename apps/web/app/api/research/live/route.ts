import { getRead, json } from "../../../../lib/api";
import { read } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^0x[0-9a-fA-F]{64}$/;

// Research desk poll: running + recent pods (or the given markets'), with stage, agent counts, failure reason and verdict.
export async function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter((x) => ID.test(x)).slice(0, 50);
  return json(await read.researchLive(await getRead(), { ids }));
}

import { getRead, json } from "../../../../lib/api";
import { read } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await read.bookLive(await getRead()));
}

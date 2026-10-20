import { getRead, json } from "../../../lib/api";
import { terminal } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await terminal.status(await getRead()));
}

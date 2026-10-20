import { getRead, json } from "../../../../lib/api";
import { terminal } from "../../../../lib/jobs";

export const runtime = "nodejs";

export async function POST() {
  return json({ acked: await terminal.ackAlerts(await getRead()) });
}

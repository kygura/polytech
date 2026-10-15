import { getDeps, json } from "../../../../lib/api";
import { kill } from "../../../../lib/jobs";

export const runtime = "nodejs";

export async function POST() {
  return json(await kill(await getDeps()));
}

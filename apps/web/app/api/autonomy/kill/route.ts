import { json } from "../../../../lib/api";
import { dbReady, defaultNow, envExchange, kill } from "../../../../lib/jobs";

export const runtime = "nodejs";

// minimal deps (db + now + exchange): kill must work even when settings / SDK init fails
export async function POST() {
  return json(await kill({ db: await dbReady(), now: defaultNow, exchange: envExchange() }));
}

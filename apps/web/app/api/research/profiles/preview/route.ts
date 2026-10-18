import { ProfileFilterSchema } from "@pm/core";
import { z } from "zod";
import { getRead, json, parseBody } from "../../../../../lib/api";
import { matchMarkets } from "../../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { data, res } = await parseBody(req, z.strictObject({ filter: ProfileFilterSchema }));
  if (res) return res;
  const d = await getRead();
  return json(await matchMarkets(d.db, data.filter, d.now()));
}

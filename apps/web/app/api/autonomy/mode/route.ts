import { z } from "zod";
import { getDeps, json, parseBody } from "../../../../lib/api";
import { setMode } from "../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.object({ to: z.enum(["L0", "L1", "L2", "L3", "L4"]), reason: z.string().max(500).optional() });

export async function POST(req: Request) {
  const b = await parseBody(req, Body);
  return b.res ?? json(await setMode(await getDeps(), b.data.to, b.data.reason));
}

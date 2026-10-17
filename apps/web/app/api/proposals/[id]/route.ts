import { z } from "zod";
import { decisionResponse, getDeps, notFound, parseBody } from "../../../../lib/api";
import { decide } from "../../../../lib/jobs";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["approve", "reject"]), via: z.enum(["web", "tui"]).default("web") });

// Session-authenticated (proxy.ts). No token: the session is the authority.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!z.uuid().safeParse(id).success) return notFound();
  const b = await parseBody(req, Body);
  return b.res ?? decisionResponse(await decide(await getDeps(), id, b.data.action, b.data.via));
}

import { z } from "zod";
import { getRead, json, notFound, parse } from "../../../../../lib/api";
import { terminal } from "../../../../../lib/jobs";

export const runtime = "nodejs";

const Id = z.coerce.number().int().positive();

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parse(Id, (await params).id);
  if (id.res) return id.res;
  return (await terminal.ackAlerts(await getRead(), id.data)) ? json({ ok: true }) : notFound(); // unknown or already acked
}

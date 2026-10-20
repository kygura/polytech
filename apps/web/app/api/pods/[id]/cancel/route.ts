import { getRead, json, notFound } from "../../../../../lib/api";
import { requestCancel } from "../../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 202 { ok } once cancelRequestedAt is set (the pod stops within ~2 s); 404 unknown pod; 409 pod not running. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await requestCancel(await getRead(), (await params).id);
  return r === "ok" ? json({ ok: true }, 202) : r === "not_found" ? notFound() : json({ error: "not running" }, 409);
}

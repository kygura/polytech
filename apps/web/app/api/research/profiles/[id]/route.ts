import { ProfileInputSchema } from "@pm/core";
import { getRead, json, notFound, parseBody } from "../../../../../lib/api";
import { deleteProfile, getProfile, updateProfile } from "../../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const p = await getProfile((await getRead()).db, (await params).id);
  return p ? json(p) : notFound();
}

/** Full replace (same body as POST). */
export async function PUT(req: Request, { params }: Ctx) {
  const { data, res } = await parseBody(req, ProfileInputSchema);
  if (res) return res;
  const r = await updateProfile((await getRead()).db, (await params).id, data);
  return r === null ? notFound() : r === "name_taken" ? json({ error: "name_taken" }, 409) : json(r);
}

export async function DELETE(_: Request, { params }: Ctx) {
  return (await deleteProfile((await getRead()).db, (await params).id)) ? json({ ok: true }) : notFound();
}

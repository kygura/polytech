import { ProfileInputSchema } from "@pm/core";
import { getRead, json, parseBody } from "../../../../lib/api";
import { createProfile, listProfiles } from "../../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await listProfiles((await getRead()).db));
}

export async function POST(req: Request) {
  const { data, res } = await parseBody(req, ProfileInputSchema);
  if (res) return res;
  const r = await createProfile((await getRead()).db, data);
  return r === "name_taken" ? json({ error: "name_taken" }, 409) : json(r, 201);
}

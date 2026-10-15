import { ZodError } from "zod";
import { getDeps, json } from "../../../lib/api";
import { read } from "../../../lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await read.settingsGet(await getDeps()));
}

export async function PUT(req: Request) {
  try {
    return json(await read.settingsPut(await getDeps(), await req.json().catch(() => undefined)));
  } catch (e) {
    if (e instanceof ZodError) return json({ error: "invalid", issues: e.issues }, 400);
    throw e;
  }
}

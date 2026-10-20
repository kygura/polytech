import { SESSION_COOKIE, authDisabled, bearer, verifySession } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookie = (h: string | null, name: string) => h?.split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);

// Public on purpose (proxy.ts PUBLIC): answers only "is this request an operator session", so the shell can tell /trade visitors apart. Nothing else.
export async function GET(req: Request) {
  const operator = authDisabled() || (await verifySession(cookie(req.headers.get("cookie"), SESSION_COOKIE))) || (await verifySession(bearer(req.headers.get("authorization"))));
  return Response.json({ operator }, { headers: { "cache-control": "no-store" } });
}

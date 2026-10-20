import { SESSION_COOKIE, bearer, verifySession } from "../../../../../lib/auth";

// Node, not edge: egress must leave from the pinned function region (vercel.json), not a PoP near the browser.
export const runtime = "nodejs";

// Browser -> Polymarket REST relay for the operator's own browser-signed SDK calls. Keys never reach us: we only
// forward the already-signed request. Session required (also enforced by proxy.ts); fixed upstream hosts only.
const HOSTS: Record<string, string> = {
  clob: "https://clob.polymarket.com",
  gamma: "https://gamma-api.polymarket.com",
  data: "https://data-api.polymarket.com",
  relayer: "https://relayer-v2.polymarket.com",
};
const TIMEOUT_MS = 15_000;

const cookie = (header: string | null, name: string) => header?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

async function relay(req: Request, { params }: { params: Promise<{ host: string; path: string[] }> }) {
  const h = req.headers;
  if (!(await verifySession(cookie(h.get("cookie"), SESSION_COOKIE))) && !(await verifySession(bearer(h.get("authorization"))))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { host, path } = await params;
  const base = Object.hasOwn(HOSTS, host) ? HOSTS[host] : undefined;
  if (!base) return Response.json({ error: "unknown host" }, { status: 404 });

  // L2 HMAC signs the SDK's relative path ("/order"), so the upstream path must be exactly the part after /api/pm/<host>.
  const target = `${base}/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`;
  const headers = new Headers();
  for (const [k, v] of h) if (k === "content-type" || k.startsWith("poly_")) headers.set(k, v); // no cookie/host/x-forwarded-*
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  try {
    const r = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const out = new Headers();
    for (const [k, v] of r.headers) if (k === "content-type" || k === "retry-after" || k.startsWith("poly-")) out.set(k, v);
    return new Response(r.body, { status: r.status, headers: out });
  } catch {
    return Response.json({ error: "upstream unreachable" }, { status: 502 });
  }
}

export { relay as GET, relay as POST, relay as PUT, relay as PATCH, relay as DELETE };

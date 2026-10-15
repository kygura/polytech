import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, bearer, checkCron, verifySession } from "./lib/auth";

const PUBLIC = new Set(["/login", "/api/login"]);

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();

  const auth = req.headers.get("authorization");
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  if (pathname.startsWith("/api/cron/")) {
    return checkCron(auth) ? NextResponse.next() : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if ((await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) || (await verifySession(bearer(auth)))) {
    return NextResponse.next();
  }

  if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL("/login", req.url);
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { checkCron } from "./lib/auth";

// No login: every page and API route is open. Only cron (CRON_SECRET) is guarded, and /api/public/* (the terminal's read API) stays GET/HEAD-only.
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/cron/") && !checkCron(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (pathname.startsWith("/api/public/") && req.method !== "GET" && req.method !== "HEAD") {
    return NextResponse.json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import { verify } from "@node-rs/argon2";
import { getKv } from "@pm/db";
import { NextResponse } from "next/server";
import { LOGIN_WINDOW_MS, clientIp, loginRateLimit, sessionCookie, signSession } from "../../../lib/auth";

export async function POST(req: Request) {
  const rl = await loginRateLimit(getKv(), clientIp(req.headers));
  if (!rl.ok) {
    return NextResponse.json(
      { error: "too many attempts" },
      { status: 429, headers: { "Retry-After": String(LOGIN_WINDOW_MS / 1000) } },
    );
  }

  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash || !process.env.JWT_SECRET) return NextResponse.json({ error: "auth not configured" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as { password?: unknown; client?: unknown } | null;
  const password = body?.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  if (!(await verify(hash, password).catch(() => false))) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await signSession();
  const tui = req.headers.get("x-client") === "tui" || body?.client === "tui";
  const res = NextResponse.json(tui ? { ok: true, token } : { ok: true });
  res.cookies.set(sessionCookie(token));
  return res;
}

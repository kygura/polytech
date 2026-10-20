import { verify } from "@node-rs/argon2";
import { getKv } from "@pm/db";
import { NextResponse } from "next/server";
import {
  LOGIN_WINDOW_MS,
  clearLoginFailures,
  clientIp,
  loginLockRemainingMs,
  loginRateLimit,
  passwordHash,
  recordLoginFailure,
  sessionCookie,
  signSession,
} from "../../../lib/auth";

const misconfigured = (e: unknown) => {
  // Error class + message only; messages never contain the hash or password.
  console.error("login: auth misconfigured:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  return NextResponse.json({ error: "auth not configured" }, { status: 500 });
};

const tooMany = (retryAfterS: number) =>
  NextResponse.json({ error: "too many attempts" }, { status: 429, headers: { "Retry-After": String(retryAfterS) } });

export async function POST(req: Request) {
  const kv = getKv();
  const ip = clientIp(req.headers);
  // "unknown" is one shared bucket (see loginRateLimit): exempt from the lockout so it can't lock the owner out.
  const lockedMs = ip === "unknown" ? 0 : await loginLockRemainingMs(kv, ip);
  if (lockedMs > 0) return tooMany(Math.ceil(lockedMs / 1000));

  const rl = await loginRateLimit(kv, ip);
  if (!rl.ok) return tooMany(LOGIN_WINDOW_MS / 1000);

  let hash: string;
  try {
    hash = passwordHash();
    if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing");
  } catch (e) {
    return misconfigured(e);
  }

  const fail = async () => {
    if (ip !== "unknown") await recordLoginFailure(kv, ip);
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  };

  const body = (await req.json().catch(() => null)) as { password?: unknown; client?: unknown } | null;
  const password = body?.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) return fail();
  let ok: boolean;
  try {
    ok = await verify(hash, password);
  } catch (e) {
    return misconfigured(e); // verify error ≠ mismatch: fail closed but visible
  }
  if (!ok) return fail();

  if (ip !== "unknown") await clearLoginFailures(kv, ip);
  const token = await signSession();
  const tui = req.headers.get("x-client") === "tui" || body?.client === "tui";
  const res = NextResponse.json(tui ? { ok: true, token } : { ok: true });
  res.cookies.set(sessionCookie(token));
  return res;
}

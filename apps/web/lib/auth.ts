import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Kv } from "@pm/db";

// Pure auth helpers. No argon2 here: this module is imported by proxy.ts, hashing stays in the login route.

export const SESSION_COOKIE = "pm_session";
export const SESSION_TTL_S = 7 * 24 * 60 * 60;
export const LOGIN_LIMIT = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Throws if JWT_SECRET is missing or shorter than 32 bytes (fail closed). */
function secret(): Uint8Array {
  const s = new TextEncoder().encode(process.env.JWT_SECRET ?? "");
  if (s.length < 32) throw new Error("JWT_SECRET missing or shorter than 32 bytes");
  return s;
}

export async function signSession(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(secret());
}

/** True only for a valid, unexpired HS256 token signed with JWT_SECRET. Never throws. */
export async function verifySession(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"], requiredClaims: ["exp", "sub"] });
    return payload.sub === "owner";
  } catch {
    return false;
  }
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_S) {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

/** Constant-time string compare (hashing first hides length). */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

/** Cron routes: `Authorization: Bearer ${CRON_SECRET}`. Fails closed when the secret is unset. */
let warnedCron = false;
export function checkCron(authorization: string | null, cronSecret = process.env.CRON_SECRET): boolean {
  if (!cronSecret || !authorization) return false;
  if (new TextEncoder().encode(cronSecret).length < 32) {
    if (!warnedCron) console.error("CRON_SECRET shorter than 32 bytes: cron routes disabled");
    warnedCron = true;
    return false;
  }
  return safeEqual(authorization, `Bearer ${cronSecret}`);
}

export function bearer(authorization: string | null): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/** Relative same-origin path only; anything else falls back to "/". */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f]/.test(next)) return "/";
  try {
    const u = new URL(next, "http://x");
    return u.origin === "http://x" ? next : "/";
  } catch {
    return "/";
  }
}

/**
 * APP_PASSWORD_HASH as a PHC string. Next's .env loader runs dotenv-expand, which eats unescaped `$...`,
 * so .env files must use `\$`; strip those escapes here so the same value also works where nothing
 * expands (Vercel dashboard). PHC strings never contain backslashes. Throws on a missing/mangled value.
 */
export function passwordHash(raw = process.env.APP_PASSWORD_HASH): string {
  const h = (raw ?? "").replaceAll("\\$", "$");
  if (!h.startsWith("$argon2id$")) {
    throw new Error(`APP_PASSWORD_HASH malformed (len ${h.length}); in .env files escape every $ as \\$`);
  }
  return h;
}

/** Vercel rewrites x-forwarded-for, so its first hop is the client. Self-hosted: rightmost XFF hop; x-real-ip only when XFF is absent. Correct only behind exactly one appending proxy. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (process.env.VERCEL) return xff[0] || "unknown";
  return xff.at(-1) || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Counts every attempt (success or failure): 5 per 15 min per IP. With no IP at all, one shared bucket at 50 so it can't lock the owner out. */
export function loginRateLimit(kv: Kv, ip: string) {
  return kv.rateLimit(`login:${ip}`, ip === "unknown" ? 50 : LOGIN_LIMIT, LOGIN_WINDOW_MS);
}

/** Exponential lockout on failed logins per IP: lock after LOCK_THRESHOLD consecutive failures, 15 min doubling per further failure, capped at 24 h. */
export const LOCK_THRESHOLD = 5;
const LOCK_BASE_MS = 15 * 60 * 1000;
export const LOCK_CAP_MS = 24 * 60 * 60 * 1000;

/** Lock duration once `failures` consecutive failures are recorded (0 below the threshold). */
export function lockMs(failures: number): number {
  return failures < LOCK_THRESHOLD ? 0 : Math.min(LOCK_BASE_MS * 2 ** (failures - LOCK_THRESHOLD), LOCK_CAP_MS);
}

type LoginFailures = { n: number; until: number };
const failKey = (ip: string) => `login:fail:${ip}`;

/** Milliseconds left on this IP's lockout; 0 when not locked. */
export async function loginLockRemainingMs(kv: Kv, ip: string, now = Date.now()): Promise<number> {
  const s = await kv.get<LoginFailures>(failKey(ip));
  return s && s.until > now ? s.until - now : 0;
}

/** Records one failed attempt. The streak is forgotten LOCK_CAP_MS after its lock ends (so a 24 h lock never outlives its own record). */
export async function recordLoginFailure(kv: Kv, ip: string, now = Date.now()): Promise<void> {
  const n = ((await kv.get<LoginFailures>(failKey(ip)))?.n ?? 0) + 1;
  const lock = lockMs(n);
  await kv.set(failKey(ip), { n, until: now + lock }, lock + LOCK_CAP_MS);
}

/** A successful login resets the streak. */
export async function clearLoginFailures(kv: Kv, ip: string): Promise<void> {
  await kv.set(failKey(ip), { n: 0, until: 0 }, LOCK_CAP_MS);
}

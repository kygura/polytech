import { createHash, timingSafeEqual } from "node:crypto";

// No login: the only auth left is the cron bearer (CRON_SECRET).

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

/** Vercel rewrites x-forwarded-for, so its first hop is the client. Self-hosted: rightmost XFF hop; x-real-ip only when XFF is absent. Correct only behind exactly one appending proxy. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (process.env.VERCEL) return xff[0] || "unknown";
  return xff.at(-1) || headers.get("x-real-ip")?.trim() || "unknown";
}

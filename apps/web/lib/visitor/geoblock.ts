// Polymarket geoblock check, run from the visitor's browser so it sees the visitor's IP (never our server's).
// Endpoint per Polymarket docs (api-reference/geoblock): GET on polymarket.com returning { blocked, ip, country, region }.
// UNVERIFIED: the build machine cannot reach Polymarket; URL and CORS must be confirmed from an unblocked browser.
export const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";

export type Geo =
  | { blocked: false; country?: string; region?: string }
  | { blocked: true; reason: "blocked"; country?: string; region?: string }
  | { blocked: true; reason: "check_failed" };

const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

/** Fails closed: network error, timeout, non-OK status or an unparseable body all mean blocked. */
export async function checkGeoblock(fetchFn: typeof fetch = fetch, timeoutMs = 8_000): Promise<Geo> {
  try {
    const res = await fetchFn(GEOBLOCK_URL, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { blocked: true, reason: "check_failed" };
    const body: unknown = await res.json();
    const b = body as { blocked?: unknown; country?: unknown; region?: unknown } | null;
    if (typeof b !== "object" || b === null || typeof b.blocked !== "boolean") return { blocked: true, reason: "check_failed" };
    const where = { country: str(b.country), region: str(b.region) };
    return b.blocked ? { blocked: true, reason: "blocked", ...where } : { blocked: false, ...where };
  } catch {
    return { blocked: true, reason: "check_failed" };
  }
}

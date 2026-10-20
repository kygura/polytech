// Views whose GET lives under another name; the Shell refresh probe must hit the real one (matched by first path segment).
const OWN: Record<string, string> = { research: "/api/research/profiles", journal: "/api/calibration" };
const SAME = new Set(["markets", "watchlist", "paper", "autonomy", "settings"]); // /api/<path> exists as-is

/** API URL to probe before an RSC refresh, or null when the view has no known GET (skip the probe, just refresh). */
export function probeUrl(pathname: string, search = ""): string | null {
  const [, root = "", id, ...rest] = pathname.split("/");
  if (root === "runs") return !id ? "/api/fleet" : rest.length ? null : `/api/pods/${id}`;
  if (OWN[root]) return OWN[root]!;
  if (root === "watchlist" && new URLSearchParams(search).get("tab") === "alerts") return "/api/alerts"; // the alerts tab is not a watchlist tab
  return SAME.has(root) ? `/api${pathname}${search}` : null;
}

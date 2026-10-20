import { pickRunner } from "@pm/agents";
import { feeExponentOf, feeRateFor } from "@pm/core";
import { getKv, schema as s, type Db, type Kv } from "@pm/db";
import { max } from "drizzle-orm";
import { clientIp } from "./auth";
import type { StructDetail } from "./jobs/screen";
import type { marketDetail, WatchlistRow } from "./jobs/read";

// Public (anonymous) projections. Explicit allowlists only: a field added to read.ts stays private until listed here.
// Excluded on purpose: pin/mute flags, operator sizing (sizeUsd, shares, expectedProfit, rank, k, e, r, payoff, struct sizeUsd),
// paper positions, pod internals (pod, podId, trigger, roleMix), agent model/usage/duration, judge model.
// Client code: import these with `import type` (this module pulls server deps).

/** disabled = instance has no research (prod without ANTHROPIC_API_KEY); pending = no thesis yet; researching = pod running now. */
export type ResearchStatus = "disabled" | "pending" | "researching" | "done";
/** Same rule the jobs use to refuse fake research. */
export const researchDisabled = async () => (await pickRunner()).kind === "disabled";
const researchOf = (hasThesis: boolean, running: boolean, disabled: boolean): ResearchStatus =>
  hasThesis ? "done" : disabled ? "disabled" : running ? "researching" : "pending";

const pick = <T, K extends keyof T>(o: T, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

export const STRUCT_KEYS = ["type", "kind", "lockedC", "sum", "legs"] as const;
export type PublicStruct = Pick<StructDetail, (typeof STRUCT_KEYS)[number]>;
const struct = (x: StructDetail | null | undefined) => (x ? pick(x, STRUCT_KEYS) : null);

// capped = judge disagreement cap tripped: an input of core `qualifies`, so it is public.
export const WATCH_KEYS = [
  "conditionId", "question", "category", "tier", "shortlisted", "priority", "midNow", "daysLeft", "endDate",
  "thesisId", "thesisAgeH", "expired", "capped", "nextCatalyst", "side", "pMid", "pHat", "c", "pPost", "edgeC", "rAnn",
] as const;
export type PublicWatchRow = Pick<WatchlistRow, (typeof WATCH_KEYS)[number]> & { structural: PublicStruct | null; research: ResearchStatus };
export const publicWatchRow = (r: WatchlistRow, disabled = false): PublicWatchRow =>
  ({ ...pick(r, WATCH_KEYS), structural: struct(r.structural), research: researchOf(r.thesisId != null, r.researching, disabled) });

/** Data age for the UI stale hint (6 h) and the visitor loop cutoff (2 h). All epoch ms; null = never. */
export type Freshness = { sweptAt: number | null; snapshotAt: number | null; stale: boolean };
export const STALE_MS = 6 * 3_600_000;
export const KICK_AT = "kick:sweepAt"; // written by the sweep on success (public sweptAt); kickIfStale keeps its own key
export async function freshness(db: Db, kv: Kv, now: number): Promise<Freshness> {
  const [sweptAt, snap, latest] = await Promise.all([kv.get<number>(KICK_AT), db.select({ ts: max(s.snapshots.ts) }).from(s.snapshots), db.select({ ts: max(s.marketLatest.ts) }).from(s.marketLatest)]);
  const snapshotAt = Math.max(snap[0]?.ts?.getTime() ?? 0, latest[0]?.ts?.getTime() ?? 0) || null; // history rows skip unchanged books; market_latest moves every run
  return { sweptAt, snapshotAt, stale: snapshotAt == null || now - snapshotAt > STALE_MS };
}
export type PublicWatchlist = Freshness & { research: "on" | "disabled"; rows: PublicWatchRow[] };

type Detail = NonNullable<Awaited<ReturnType<typeof marketDetail>>>;
type Thesis = NonNullable<Detail["thesis"]>;

// Thesis age = thesis.createdAt; data age = snapshot.ts. Everything the visitor loop needs for sizeTrade / livelimitPrice / checkOrder / qualifies: YES book (bids, asks, mid),
// crowd inputs (top10Share, netFlow), endDate/daysLeft, resolved feeRate, category, eventId + negRiskGroup (exposure key),
// thesis pYes + c (already capped by category confidence) + side + capped, token ids. tickSize (null = unknown, treat as 0.01).
export const MARKET_KEYS = ["conditionId", "question", "rules", "category", "tags", "eventId", "negRiskGroup", "endDate", "daysLeft", "status", "tickSize", "yesTokenId", "noTokenId"] as const;
export const SNAP_KEYS = ["ts", "mid", "bestBid", "bestAsk", "depth5cUsd", "vol24h", "oi", "top10Share", "bids", "asks", "netFlow"] as const;
export const SCREEN_KEYS = ["ts", "R", "I", "L", "T", "C", "priority", "tier"] as const;
export const THESIS_KEYS = ["id", "createdAt", "expiresAt", "side", "pHat", "c", "pPost", "edgeC", "rAnn", "catalysts", "killCriteria", "thesis", "pYes", "pMidYes", "extremize", "capped"] as const;
export const MARKER_KEYS = ["createdAt", "pHat", "side"] as const;
export const EVIDENCE_KEYS = ["id", "role", "claim", "quote", "url", "direction", "publishedAt", "retrievedAt"] as const;
export const AGENT_KEYS = ["role", "status", "probability", "confidence"] as const;

export type PublicMarketDetail = {
  market: Pick<Detail["market"], (typeof MARKET_KEYS)[number]> & { feeRate: number; feeExponent: number; negRisk: boolean };
  snapshot: Pick<NonNullable<Detail["snapshot"]>, (typeof SNAP_KEYS)[number]> | null;
  history: { ts: number; mid: number | null }[];
  screen: (Pick<NonNullable<Detail["screen"]>, (typeof SCREEN_KEYS)[number]> & { structural: PublicStruct | null }) | null;
  thesis: Pick<Thesis, (typeof THESIS_KEYS)[number]> | null;
  thesisMarkers: Pick<Detail["thesisMarkers"][number], (typeof MARKER_KEYS)[number]>[];
  evidence: Pick<Detail["evidence"][number], (typeof EVIDENCE_KEYS)[number]>[];
  agents: Pick<Detail["agents"][number], (typeof AGENT_KEYS)[number]>[];
  research: ResearchStatus;
};

/** Evidence links come from model output: only http(s) reaches an anonymous page (no javascript:, data:, ...). "" = dropped. */
export const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");

export function publicMarketDetail(d: Detail, disabled = false): PublicMarketDetail {
  const m = d.market;
  return {
    market: { ...pick(m, MARKET_KEYS), feeRate: feeRateFor(m.category ?? "other", m.feeRate).rate, feeExponent: feeExponentOf(m.feeExponent), negRisk: m.negRiskGroup != null },
    snapshot: d.snapshot ? pick(d.snapshot, SNAP_KEYS) : null,
    history: d.history.map((h) => ({ ts: h.ts, mid: h.mid })),
    screen: d.screen ? { ...pick(d.screen, SCREEN_KEYS), structural: struct(d.screen.structural as StructDetail | null) } : null,
    thesis: d.thesis ? pick(d.thesis, THESIS_KEYS) : null,
    thesisMarkers: d.thesisMarkers.map((x) => pick(x, MARKER_KEYS)),
    evidence: d.evidence.map((x) => ({ ...pick(x, EVIDENCE_KEYS), url: safeUrl(x.url) })),
    agents: d.agents.map((x) => pick(x, AGENT_KEYS)),
    research: researchOf(d.thesis != null, d.pod?.status === "running", disabled),
  };
}

// ---- transport: per-IP limit + CDN cache
export const PUBLIC_LIMIT = 60, PUBLIC_WINDOW_MS = 60_000;
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";

const limited = (retryAfter: number) => Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } });
/** 429 Response when the caller's IP is over 60/min, else null. */
export async function publicLimit(req: Request, kv: Kv = getKv()): Promise<Response | null> {
  const r = await kv.rateLimit(`pub:${clientIp(req.headers)}`, PUBLIC_LIMIT, PUBLIC_WINDOW_MS);
  return r.ok ? null : limited(PUBLIC_WINDOW_MS / 1000);
}
/** The live feed polls every few seconds, so it gets its own bucket (120/min per IP) and never eats the 60/min of the other public routes. */
export const FEED_LIMIT = 120;
export async function publicFeedLimit(req: Request, kv: Kv = getKv()): Promise<Response | null> {
  const r = await kv.rateLimit(`pubfeed:${clientIp(req.headers)}`, FEED_LIMIT, PUBLIC_WINDOW_MS);
  return r.ok ? null : limited(PUBLIC_WINDOW_MS / 1000);
}
export const publicJson = (body: unknown) => Response.json(body, { headers: { "cache-control": CACHE } });

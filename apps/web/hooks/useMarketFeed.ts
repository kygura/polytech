"use client";
import { useRef } from "react";
import { FEED_POLL_MS, MarketFeedSchema, type MarketFeed } from "../lib/feed";
import { usePoll } from "./usePoll";

export type { FeedLevel, MarketFeed } from "../lib/feed";
export type FeedStatus = "loading" | "live" | "stale" | "error";
export const FEED_STALE_MS = 3 * FEED_POLL_MS;

/** Age of a feed by the server clock stamp, not by when this client received it (a CDN-cached response is already old on arrival). */
export const feedAge = (f: Pick<MarketFeed, "at">, now: number) => now - f.at;

/** loading = nothing yet; live = fresh data; stale = last good data kept after a failure or server age (Date.now() - data.at) > FEED_STALE_MS; error = failing with nothing to show. */
export function feedStatus(hasData: boolean, failing: boolean, ageMs: number): FeedStatus {
  if (!hasData) return failing ? "error" : "loading";
  return failing || ageMs > FEED_STALE_MS ? "stale" : "live";
}

/** Polls /api/public/markets/:id/feed every FEED_POLL_MS (paused while the tab is hidden). The payload is zod-parsed; an invalid one counts as a failure and the last good feed stays. */
export function useMarketFeed(conditionId: string): { data: MarketFeed | null; status: FeedStatus; lastAt: number | null } {
  const p = usePoll<unknown>(`/api/public/markets/${encodeURIComponent(conditionId)}/feed`, FEED_POLL_MS);
  const good = useRef<{ id: string; at: number | null; data: MarketFeed } | null>(null);
  let bad = p.error != null;
  if (p.data != null && p.lastAt !== good.current?.at) {
    const r = MarketFeedSchema.safeParse(p.data);
    if (r.success) good.current = { id: conditionId, at: p.lastAt, data: r.data };
    else bad = true;
  }
  const g = good.current?.id === conditionId ? good.current : null;
  return { data: g?.data ?? null, status: feedStatus(g != null, bad, g ? feedAge(g.data, Date.now()) : 0), lastAt: g?.at ?? null };
}

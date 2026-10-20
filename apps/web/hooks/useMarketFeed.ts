"use client";
import { subscribeBooks, type SocketStatus } from "@pm/pm/ws";
import type { Book } from "@pm/pm";
import { useEffect, useRef, useState } from "react";
import { FEED_DEPTH, FEED_POLL_MS, MarketFeedSchema, type MarketFeed } from "../lib/feed";
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

export const feedUrl = (conditionId: string | null) => (conditionId ? `/api/public/markets/${encodeURIComponent(conditionId)}/feed` : null);
/** The feed route answers 404 when the venue has no book for the token (502 = venue down, which is an error, not "no book"). */
export const isNoBook = (status: number | null) => status === 404;

// ---- WebSocket upgrade (SPEC Rev 7: the live book upgrades to the CLOB WebSocket and falls back to the poll) ----
export type FeedSource = "ws" | "poll";
/** Poll cadence while the WebSocket is healthy: still needed for the tape, own tick size and min order size. */
export const WS_POLL_MS = 15_000;
/** `NEXT_PUBLIC_PM_WS=0` turns the upgrade off (default on). Polymarket's WS host may be blocked on some networks; the poll covers that either way. */
export const WS_ENABLED = process.env.NEXT_PUBLIC_PM_WS !== "0";
/** Updates are coalesced to one render per this many ms. */
export const WS_FLUSH_MS = 120;

/** WebSocket state for one market. `book` is null until the first snapshot after every (re)connect. */
export type WsState = { id: string; status: SocketStatus; book: Book | null; at: number };

/** Healthy = open socket for this market that has delivered a snapshot. */
export const wsHealthy = (ws: WsState | null, conditionId: string | null): boolean => ws != null && ws.id === conditionId && ws.status === "open" && ws.book != null;
export const pollInterval = (healthy: boolean) => (healthy ? WS_POLL_MS : FEED_POLL_MS);
/** Open the socket only for a selected market (token known), with a WebSocket available, flag on, and the tab visible. */
export const shouldOpenWs = (o: { enabled: boolean; tokenId: string | null; visible: boolean; supported: boolean }) => o.enabled && o.supported && o.visible && o.tokenId != null;

/** The poll payload with the ladder, mid, last and tick taken from the WebSocket book; tape and min order size stay from the poll. `at` is the local receive time. */
export function wsFeed(base: MarketFeed, book: Book, at: number): MarketFeed {
  const bid = book.bids[0]?.price, ask = book.asks[0]?.price;
  return {
    ...base,
    tickSize: book.tick_size ?? base.tickSize,
    minOrderSize: book.min_order_size ?? base.minOrderSize,
    bids: book.bids.slice(0, FEED_DEPTH), asks: book.asks.slice(0, FEED_DEPTH),
    mid: bid != null && ask != null ? (bid + ask) / 2 : null,
    last: book.last_trade_price ?? base.last,
    at,
  };
}

/**
 * Which feed the UI shows. A healthy socket (open + snapshot received for the poll's token) wins and is "live" by definition (the
 * client pings and drops a silent socket, so a quiet book is not stale); otherwise the poll, aged by its server stamp.
 */
export function selectFeed(poll: { data: MarketFeed | null; failing: boolean }, ws: WsState | null, conditionId: string | null, now: number): { data: MarketFeed | null; status: FeedStatus; source: FeedSource } {
  const p = poll.data;
  if (p && ws && ws.book && wsHealthy(ws, conditionId) && ws.book.token_id === p.tokenId) return { data: wsFeed(p, ws.book, ws.at), status: "live", source: "ws" };
  return { data: p, status: feedStatus(p != null, poll.failing, p ? feedAge(p, now) : 0), source: "poll" };
}

/**
 * Live book for the selected market. Polls /api/public/markets/:id/feed (3 s; paused while the tab is hidden) and, once the poll has
 * named the YES token, opens the CLOB market WebSocket for it. While the socket is open with a snapshot the ladder/mid come from it and
 * the poll drops to 15 s; on close/error the poll is refetched at once and returns to 3 s. The socket closes on market change, unmount and
 * tab hidden. The payload is zod-parsed; an invalid one counts as a failure and the last good feed stays. `noBook` = the venue has no
 * book for the token (HTTP 404). `conditionId` null = nothing polled.
 */
export function useMarketFeed(conditionId: string | null): { data: MarketFeed | null; status: FeedStatus; lastAt: number | null; noBook: boolean; source: FeedSource } {
  const [ws, setWs] = useState<WsState | null>(null);
  const healthy = wsHealthy(ws, conditionId);
  const p = usePoll<unknown>(feedUrl(conditionId), pollInterval(healthy));
  const good = useRef<{ id: string; at: number | null; data: MarketFeed } | null>(null);
  let bad = p.error != null;
  if (conditionId && p.data != null && p.lastAt !== good.current?.at) {
    const r = MarketFeedSchema.safeParse(p.data);
    if (r.success) good.current = { id: conditionId, at: p.lastAt, data: r.data };
    else bad = true;
  }
  const g = good.current?.id === conditionId ? good.current : null;
  const tokenId = g?.data.tokenId ?? null;

  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const f = () => setVisible(document.visibilityState === "visible");
    f();
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);

  useEffect(() => {
    if (!conditionId || !tokenId || !shouldOpenWs({ enabled: WS_ENABLED, tokenId, visible, supported: typeof WebSocket !== "undefined" })) return;
    let sock: ReturnType<typeof subscribeBooks> | null = null, timer: ReturnType<typeof setTimeout> | undefined, latest: Book | null = null, last = 0, status: SocketStatus = "connecting";
    const flush = () => {
      timer = undefined;
      last = Math.max(Date.now(), last + 1); // strictly increasing: consumers diff on `at`
      setWs({ id: conditionId, status, book: latest, at: last });
    };
    try {
      sock = subscribeBooks([tokenId], (b) => {
        if (b.token_id !== tokenId) return;
        latest = b;
        if (!timer) timer = setTimeout(flush, WS_FLUSH_MS);
      }, {
        onStatus: (st) => {
          status = st;
          if (st !== "open") { latest = null; sock?.store.clear(); } // a reconnect starts with fresh snapshots; never show the old book as live
          clearTimeout(timer);
          flush();
        },
      });
    } catch { /* no usable WebSocket: the poll stays at 3 s */ }
    return () => {
      clearTimeout(timer);
      sock?.close();
      setWs((cur) => (cur?.id === conditionId ? null : cur));
    };
  }, [conditionId, tokenId, visible]);

  // Socket lost: the pending poll tick may be 15 s away and the last payload is old; fetch now.
  const was = useRef(false);
  const { refresh } = p;
  useEffect(() => {
    if (was.current && !healthy && document.visibilityState === "visible") refresh();
    was.current = healthy;
  }, [healthy, refresh]);

  const sel = selectFeed({ data: g?.data ?? null, failing: bad }, ws, conditionId, Date.now());
  return { ...sel, lastAt: g?.at ?? null, noBook: isNoBook(p.status) };
}

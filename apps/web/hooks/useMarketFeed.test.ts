import { describe, expect, it } from "vitest";
import { feedAge, feedStatus, feedUrl, FEED_STALE_MS, isNoBook } from "./useMarketFeed";

describe("feedStatus", () => {
  it("loading / error without data; live / stale with data", () => {
    expect(feedStatus(false, false, 0)).toBe("loading");
    expect(feedStatus(false, true, 0)).toBe("error");
    expect(feedStatus(true, false, 0)).toBe("live");
    expect(feedStatus(true, true, 0)).toBe("stale");
    expect(feedStatus(true, false, FEED_STALE_MS + 1)).toBe("stale");
  });
  it("age comes from the server stamp: a response cached 10 s upstream is stale on arrival", () => {
    const now = 1_000_000, f = { at: now - 10_000 };
    expect(feedStatus(true, false, feedAge(f, now))).toBe("stale");
    expect(feedStatus(true, false, feedAge({ at: now - 1_000 }, now))).toBe("live");
  });
  it("no market selected: nothing polled; 404 = no book, 502 is an error", () => {
    expect(feedUrl(null)).toBeNull();
    expect(feedUrl("0xab")).toBe("/api/public/markets/0xab/feed");
    expect([404, 502, 200, null].map(isNoBook)).toEqual([true, false, false, false]);
  });
});

// ---- WebSocket upgrade: source switching ----
import type { MarketFeed } from "../lib/feed";
import { pollInterval, selectFeed, shouldOpenWs, WS_POLL_MS, wsFeed, wsHealthy, type WsState } from "./useMarketFeed";

const lv = (price: number, size: number) => ({ price, size });
const poll: MarketFeed = { tokenId: "yes", tickSize: 0.01, minOrderSize: 5, bids: [lv(0.4, 10)], asks: [lv(0.43, 10)], mid: 0.415, last: 0.41, trades: [{ side: "BUY", price: 0.41, size: 3, ts: 1 }], at: 1_000_000 };
const book = { token_id: "yes", bids: [lv(0.41, 20), lv(0.4, 10)], asks: [lv(0.42, 30), lv(0.43, 10)], tick_size: 0.001, last_trade_price: 0.42 };
const ws = (o: Partial<WsState> = {}): WsState => ({ id: "c1", status: "open", book, at: 2_000_000, ...o });
const NOW = 2_000_500;

describe("wsHealthy / pollInterval", () => {
  it("healthy = open socket for this market with a snapshot", () => {
    expect(wsHealthy(ws(), "c1")).toBe(true);
    expect(wsHealthy(ws({ status: "connecting" }), "c1")).toBe(false);
    expect(wsHealthy(ws({ status: "closed" }), "c1")).toBe(false);
    expect(wsHealthy(ws({ book: null }), "c1")).toBe(false); // open but no snapshot yet
    expect(wsHealthy(ws({ id: "other" }), "c1")).toBe(false); // previous market's socket
    expect(wsHealthy(null, "c1")).toBe(false);
    expect(wsHealthy(ws(), null)).toBe(false);
  });
  it("poll drops to 15 s only while healthy", () => {
    expect(pollInterval(true)).toBe(WS_POLL_MS);
    expect(WS_POLL_MS).toBe(15_000);
    expect(pollInterval(false)).toBe(3_000);
  });
});

describe("selectFeed", () => {
  const sel = (w: WsState | null, p: MarketFeed | null = poll, failing = false) => selectFeed({ data: p, failing }, w, "c1", NOW);
  it("healthy socket wins: ws ladder/mid/tick, poll tape/min size, live regardless of the poll's age", () => {
    const r = sel(ws());
    expect(r.source).toBe("ws");
    expect(r.status).toBe("live");
    expect(r.data).toMatchObject({ bids: book.bids, asks: book.asks, tickSize: 0.001, minOrderSize: 5, trades: poll.trades, last: 0.42, at: 2_000_000 });
    expect(r.data!.mid).toBeCloseTo(0.415);
    expect(sel(ws(), { ...poll, at: NOW - 60_000 }).status).toBe("live"); // 15 s poll cadence must not read as stale
  });
  it("closed / connecting / no snapshot / other market: back to the poll", () => {
    for (const w of [ws({ status: "closed" }), ws({ status: "connecting" }), ws({ book: null }), ws({ id: "other" }), null]) {
      const r = sel(w);
      expect(r.source).toBe("poll");
      expect(r.data).toBe(poll);
    }
  });
  it("poll status keeps its own rules (loading / error / stale / live)", () => {
    expect(sel(null, null)).toMatchObject({ source: "poll", data: null, status: "loading" });
    expect(sel(null, null, true).status).toBe("error");
    expect(sel(null, { ...poll, at: NOW - 10_000 }).status).toBe("stale");
    expect(sel(null, { ...poll, at: NOW - 500 }).status).toBe("live");
    expect(sel(null, poll, true).status).toBe("stale");
  });
  it("a socket for another token than the poll's is ignored", () => {
    expect(sel(ws({ book: { ...book, token_id: "other-token" } })).source).toBe("poll");
  });
  it("no poll payload yet: nothing to overlay", () => {
    expect(sel(ws(), null)).toMatchObject({ source: "poll", data: null });
  });
});

describe("wsFeed", () => {
  it("caps depth at 15, derives mid, falls back to the poll for missing fields", () => {
    const many = Array.from({ length: 30 }, (_, i) => lv(0.4 - i * 0.01, 1));
    const r = wsFeed(poll, { token_id: "yes", bids: many, asks: [] }, 5);
    expect(r.bids).toHaveLength(15);
    expect(r.asks).toEqual([]);
    expect(r.mid).toBeNull();
    expect(r.tickSize).toBe(0.01);
    expect(r.last).toBe(0.41);
    expect(r.at).toBe(5);
  });
});

describe("shouldOpenWs", () => {
  const ok = { enabled: true, tokenId: "yes", visible: true, supported: true };
  it("opens only for a selected market, flag on, visible tab, WebSocket available", () => {
    expect(shouldOpenWs(ok)).toBe(true);
    expect(shouldOpenWs({ ...ok, tokenId: null })).toBe(false); // no market selected / no book
    expect(shouldOpenWs({ ...ok, visible: false })).toBe(false); // tab hidden closes it
    expect(shouldOpenWs({ ...ok, enabled: false })).toBe(false); // NEXT_PUBLIC_PM_WS=0
    expect(shouldOpenWs({ ...ok, supported: false })).toBe(false);
  });
});

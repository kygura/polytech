import { describe, expect, it } from "vitest";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import { cents, changedSizes, displayYes, feedDisplay, forOutcome, isWide, nudge } from "./book";

const feed: MarketFeed = {
  tokenId: "y", tickSize: 0.001, minOrderSize: 5, mid: 0.412, last: 0.41, at: 0, trades: [],
  bids: [{ price: 0.411, size: 10 }, { price: 0.41, size: 20 }], asks: [{ price: 0.413, size: 30 }, { price: 0.42, size: 40 }],
};

describe("terminal book helpers", () => {
  it("NO mirrors the YES book, best level first", () => {
    const n = forOutcome(feed, "NO");
    expect(n.bids).toEqual([{ price: 0.587, size: 30 }, { price: 0.58, size: 40 }]);
    expect(n.asks).toEqual([{ price: 0.589, size: 10 }, { price: 0.59, size: 20 }]);
    expect(n.mid).toBe(0.588);
    expect(forOutcome(feed, "YES")).toBe(feed);
  });
  it("cents follow the tick: 0.001 -> one decimal, 0.01 -> none", () => {
    expect(cents(0.412, 0.001)).toBe("41.2");
    expect(cents(0.41, 0.01)).toBe("41");
    expect(cents(0.001, 0.001)).toBe("0.1");
    expect(cents(null, 0.01)).toBe("—");
  });
  it("tints only same-price size changes, never on the first payload", () => {
    expect(changedSizes(null, feed.bids).size).toBe(0);
    expect([...changedSizes(feed.bids, [{ price: 0.411, size: 11 }, { price: 0.41, size: 20 }, { price: 0.409, size: 5 }])]).toEqual([0.411]);
  });
  it("nudges by tick, rounded for the side and clamped", () => {
    expect(nudge("BUY", 0.4125, 1, 0.001)).toBe(0.413);
    expect(nudge("SELL", 0.4125, -10, 0.001)).toBe(0.403);
    expect(nudge("BUY", 0.002, -10, 0.001)).toBe(0.001);
    expect(nudge("BUY", 0.99, 5, 0.01)).toBe(0.99);
  });
  it("wide book (> 10¢) shows the last trade, not the midpoint; a tight book shows the mid", () => {
    expect(displayYes({ bid: 0.01, ask: 0.82, mid: 0.415, last: 0.055 })).toBe(0.055);
    expect(displayYes({ bid: 0.01, ask: 0.11, mid: 0.06, last: 0.05 })).toBe(0.06); // exactly 10¢ is still tight
    expect(displayYes({ bid: 0.4, ask: 0.42, mid: 0.41, last: 0.3 })).toBe(0.41);
    expect(displayYes({ bid: 0.01, ask: 0.82, mid: 0.415, last: null })).toBe(0.415); // no trade to show: the mid is all there is
    expect(displayYes({ bid: null, ask: null, mid: null, last: 0.2 })).toBe(0.2);
    expect(isWide(0.01, 0.82)).toBe(true);
    expect(isWide(0.4, 0.42)).toBe(false);
    expect(feedDisplay({ ...feed, bids: [{ price: 0.01, size: 1 }], asks: [{ price: 0.82, size: 1 }], mid: 0.415, last: 0.055 })).toBe(0.055);
  });
});

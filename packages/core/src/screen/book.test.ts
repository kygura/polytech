import { describe, expect, it } from "vitest";
import {
  bestAsk, bestBid, bookHash, bookMetrics, capacity, capacityAtVwap, complementBook, depthAt, depthWithin, exitDepth, midOf, mirror,
  slippageCurve, spread, vwapForUsd, type Book,
} from "./book";

const asks = [
  { price: 0.6, size: 100 },
  { price: 0.5, size: 100 },
];

describe("midOf", () => {
  it("averages best bid and best ask regardless of order", () => {
    expect(midOf([{ price: 0.3, size: 1 }, { price: 0.4, size: 1 }], asks)).toBeCloseTo(0.45, 12);
  });
  it("null when a side is empty", () => {
    expect(midOf([], asks)).toBeNull();
    expect(midOf([{ price: 0.4, size: 1 }], [])).toBeNull();
  });
});

describe("depthWithin", () => {
  it("sums USD notional of levels within N cents of ref (inclusive)", () => {
    // ref .50, 5c: .50->$50, .55->$27.5, .60 excluded (10c away)
    const lv = [{ price: 0.5, size: 100 }, { price: 0.55, size: 50 }, { price: 0.6, size: 100 }];
    expect(depthWithin(lv, 0.5, 5)).toBeCloseTo(77.5, 9);
  });
  it("empty book is 0", () => expect(depthWithin([], 0.5, 5)).toBe(0));
});

describe("vwapForUsd", () => {
  it("fills inside the first level at its price", () => {
    expect(vwapForUsd(asks, 25)).toBeCloseTo(0.5, 12);
  });
  it("walks levels: $80 = 100@.5 ($50) + 50@.6 ($30) -> 80/150", () => {
    expect(vwapForUsd(asks, 80)).toBeCloseTo(80 / 150, 12);
  });
  it("usd <= 0 returns best ask", () => {
    expect(vwapForUsd(asks, 0)).toBe(0.5);
  });
  it("null when size exceeds depth ($110 total) or book empty", () => {
    expect(vwapForUsd(asks, 110.01)).toBeNull();
    expect(vwapForUsd(asks, 110)).not.toBeNull();
    expect(vwapForUsd([], 10)).toBeNull();
  });
  it("ignores junk levels", () => {
    expect(vwapForUsd([{ price: 0, size: 5 }, { price: 0.5, size: 0 }, { price: 0.4, size: 10 }], 2)).toBe(0.4);
  });
});

describe("mirror", () => {
  it("maps price to 1-price", () => {
    expect(mirror([{ price: 0.3, size: 7 }])).toEqual([{ price: 0.7, size: 7 }]);
  });
});

// ─── ported from polyscout book.test.ts ───

const book: Book = {
  bids: [{ price: 0.4, size: 100 }, { price: 0.39, size: 200 }, { price: 0.35, size: 1000 }],
  asks: [{ price: 0.42, size: 100 }, { price: 0.43, size: 200 }, { price: 0.5, size: 1000 }],
};
const empty: Book = { bids: [], asks: [] };

describe("top of book", () => {
  it("best/spread", () => {
    expect(bestBid(book)).toBe(0.4);
    expect(bestAsk(book)).toBe(0.42);
    expect(spread(book)).toBeCloseTo(0.02, 12);
  });
  it("unsorted input still finds best", () => {
    const b: Book = { bids: [{ price: 0.3, size: 1 }, { price: 0.4, size: 1 }], asks: [{ price: 0.6, size: 1 }, { price: 0.5, size: 1 }] };
    expect(bestBid(b)).toBe(0.4);
    expect(bestAsk(b)).toBe(0.5);
  });
  it("empty and one-sided -> null", () => {
    expect(bestBid(empty)).toBeNull();
    expect(bestAsk(empty)).toBeNull();
    const oneSided = { bids: book.bids, asks: [] };
    expect(spread(oneSided)).toBeNull();
    expect(bestBid(oneSided)).toBe(0.4);
  });
  it("zero-size levels ignored", () => {
    expect(bestBid({ bids: [{ price: 0.5, size: 0 }, { price: 0.4, size: 5 }], asks: [] })).toBe(0.4);
  });
});

describe("depthAt", () => {
  it("USD within X cents of mid (mid 0.41), both sides", () => {
    expect(depthAt(book, 1)).toBeCloseTo(82, 9); // bids >= .40 -> 40 ; asks <= .42 -> 42
    expect(depthAt(book, 2)).toBeCloseTo(82 + 78 + 86, 9);
    expect(depthAt(book, 5)).toBeCloseTo(82 + 78 + 86, 9); // .35 is 6c away
    expect(depthAt(book, 10)).toBeCloseTo(82 + 78 + 86 + 350 + 500, 9);
  });
  it("no mid -> 0", () => {
    expect(depthAt(empty, 5)).toBe(0);
    expect(depthAt({ bids: book.bids, asks: [] }, 5)).toBe(0);
  });
});

describe("slippageCurve / capacity", () => {
  it("curve points, unfillable and non-positive omitted", () => {
    const c = slippageCurve(book, [21, 85, 1e9, 0, -1]);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ size: 21, vwap: expect.closeTo(0.42, 12), slippage: expect.closeTo(0, 12) });
    expect(c[1]!.slippage).toBeCloseTo(85 / 200 - 0.42, 9);
    expect(slippageCurve(empty, [10])).toEqual([]);
  });
  it("capacity: whole levels within eps", () => {
    // target vwap 0.43: levels 1-2 (vwap .4267) plus a sliver of the 0.50 level
    expect(capacity(book.asks, 0.01)).toBeCloseTo(128 + 1 / 0.14, 6);
  });
  it("capacity: partial level", () => {
    const eps = 0.05; // target 0.47 ; level3 at 0.5 partially
    const cap = capacity(book.asks, eps);
    expect(vwapForUsd(book.asks, cap)! - 0.42).toBeCloseTo(eps, 9);
    expect(cap).toBeGreaterThan(135);
    expect(cap).toBeLessThan(628);
  });
  it("capacity edge cases", () => {
    expect(capacity([], 0.02)).toBe(0);
    expect(capacity(book.asks, -0.1)).toBe(0);
    expect(capacity(book.asks, 0)).toBeCloseTo(42, 9);
    expect(capacity(book.asks, 10)).toBeCloseTo(628, 9);
    expect(capacityAtVwap(book.asks, 0.41)).toBe(0);
  });
});

describe("complementBook", () => {
  it("flips sides", () => {
    const c = complementBook(book);
    expect(c.bids[0]).toEqual({ price: 0.58, size: 100 });
    expect(c.asks[0]).toEqual({ price: 0.6, size: 100 });
    expect(c.bids.map((l) => l.price)).toEqual([0.58, 0.57, 0.5]);
    expect(c.asks.map((l) => l.price)).toEqual([0.6, 0.61, 0.65]);
    expect(complementBook(c).asks.map((l) => l.price)).toEqual(book.asks.map((l) => l.price));
  });
  it("empty", () => {
    expect(complementBook(empty)).toEqual({ bids: [], asks: [] });
  });
});

describe("bookMetrics", () => {
  it("full book", () => {
    const m = bookMetrics(book, 0.01);
    expect(m.mid).toBeCloseTo(0.41, 12);
    expect(m.bestBid).toBe(0.4);
    expect(m.bestAsk).toBe(0.42);
    expect(m.spread).toBeCloseTo(0.02, 12);
    expect(m.depth1c).toBeCloseTo(82, 9);
    expect(m.depth5c).toBeCloseTo(246, 9);
    expect(m.exitDepth).toBeCloseTo(40 + 78 + 350, 9); // bids >= best bid - 5c = .35
    expect(m.capacity).toBeCloseTo(128 + 1 / 0.14, 6);
    for (const v of Object.values(m)) expect(Number.isNaN(v)).toBe(false);
  });
  it("exit depth counts bids within 5c of the best bid (not of mid) and exists with bids only", () => {
    const wide = { bids: [{ price: 0.3, size: 100 }, { price: 0.27, size: 100 }, { price: 0.2, size: 100 }], asks: [{ price: 0.8, size: 10 }] };
    expect(exitDepth(wide)).toBeCloseTo(30 + 27, 9);
    const bidsOnly = bookMetrics({ bids: wide.bids, asks: [] });
    expect(bidsOnly.mid).toBeNull();
    expect(bidsOnly.exitDepth).toBeCloseTo(57, 9);
  });
  it("empty book -> nulls", () => {
    expect(bookMetrics(empty, 0.02)).toEqual({ mid: null, bestBid: null, bestAsk: null, spread: null, depth1c: null, depth2c: null, depth5c: null, exitDepth: null, capacity: null });
  });
  it("one-sided asks: capacity known, depths null", () => {
    const m = bookMetrics({ bids: [], asks: book.asks }, 0.01);
    expect(m.mid).toBeNull();
    expect(m.depth2c).toBeNull();
    expect(m.capacity).toBeCloseTo(128 + 1 / 0.14, 6);
    expect(m.bestAsk).toBe(0.42);
  });
});

describe("bookHash", () => {
  it("stable across level order, changes with any top-N price or size", () => {
    const h = bookHash(book);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(bookHash({ bids: [...book.bids].reverse(), asks: [...book.asks].reverse() })).toBe(h);
    expect(bookHash({ ...book, asks: [{ price: 0.42, size: 101 }, ...book.asks.slice(1)] })).not.toBe(h);
    expect(bookHash({ ...book, bids: [{ price: 0.41, size: 100 }, ...book.bids.slice(1)] })).not.toBe(h);
    expect(bookHash(empty)).not.toBe(h);
  });
  it("ignores levels beyond the top N", () => {
    const deep = { ...book, asks: [...book.asks, { price: 0.9, size: 5 }] };
    expect(bookHash(deep, 3)).toBe(bookHash(book, 3));
    expect(bookHash(deep, 4)).not.toBe(bookHash(book, 4));
  });
});

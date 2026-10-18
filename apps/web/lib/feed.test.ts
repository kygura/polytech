import { createPm } from "@pm/pm";
import { describe, expect, it } from "vitest";
import { marketFeed, MarketFeedSchema } from "./feed";

const pm = createPm({ fixtures: true });

describe("marketFeed", () => {
  it("fixture market: sorted book, mid between best bid/ask, tick from the book (0.001 market)", async () => {
    const ms = await pm.listMarkets();
    const m = ms.find((x) => x.tick_size === 0.001 && x.yes_token_id)!;
    const f = (await marketFeed(pm, { conditionId: m.condition_id, yesTokenId: m.yes_token_id!, tickSize: null }, 123))!;
    expect(MarketFeedSchema.parse(f)).toEqual(f);
    expect(f.tickSize).toBe(0.001);
    expect(f.at).toBe(123);
    expect(f.bids.map((l) => l.price)).toEqual([...f.bids.map((l) => l.price)].sort((a, b) => b - a));
    expect(f.mid).toBeCloseTo((f.bids[0]!.price + f.asks[0]!.price) / 2, 9);
  });
  it("falls back to the stored tick, then 0.01; no book -> null; tape/last failures are soft; book failure throws", async () => {
    const book = { token_id: "t", bids: [{ price: 0.4, size: 1 }], asks: [{ price: 0.42, size: 1 }] };
    const ok = { books: async () => [book], lastTradePrices: async () => { throw new Error("x"); }, trades: async () => { throw new Error("x"); } };
    const m = { conditionId: "c", yesTokenId: "t" };
    expect((await marketFeed(ok, { ...m, tickSize: 0.001 }, 0))).toMatchObject({ tickSize: 0.001, last: null, trades: [] });
    expect((await marketFeed(ok, { ...m, tickSize: 0.001 }, 0))!.mid).toBeCloseTo(0.41, 9);
    expect((await marketFeed(ok, { ...m, tickSize: null }, 0))!.tickSize).toBe(0.01);
    expect(await marketFeed({ ...ok, books: async () => [] }, { ...m, tickSize: null }, 0)).toBeNull();
    await expect(marketFeed({ ...ok, books: async () => { throw new Error("down"); } }, { ...m, tickSize: null }, 0)).rejects.toThrow("down");
  });
  it("tape: this token only, newest first, wallet and tx dropped", async () => {
    const book = { token_id: "t", bids: [], asks: [] };
    const tr = (token_id: string, ts: number) => ({ token_id, ts, price: 0.5, size: 1, side: "BUY", wallet: "0xw", tx: "0xt" });
    const f = (await marketFeed({ books: async () => [book], lastTradePrices: async () => ({ t: 0.5 }), trades: async () => [tr("t", 1), tr("o", 2), tr("t", 3)] }, { conditionId: "c", yesTokenId: "t", tickSize: null }, 0))!;
    expect(f.trades).toEqual([{ side: "BUY", price: 0.5, size: 1, ts: 3 }, { side: "BUY", price: 0.5, size: 1, ts: 1 }]);
    expect(f.last).toBe(0.5);
    expect(f.mid).toBeNull();
  });
});

import { fakeExchange } from "@pm/pm";
import { describe, expect, it } from "vitest";
import { buildOrder, canPlace, sendIfCurrent, orderStatus, recheckOrder, sendOrder, type OrderInput } from "./useOrderFlow";

const nowait = async () => {};
const rej = (e: unknown) => e instanceof Error && /rejected/.test(e.message);
const buy: OrderInput = { side: "BUY", tokenId: "yes", price: 0.4569, shares: 10, tick: 0.001 };
const sell: OrderInput = { side: "SELL", tokenId: "no", price: 0.6, shares: 7, tick: 0.01 };

describe("order flow transitions", () => {
  it("buildOrder: token and side pass through, price rounds down to the tick, GTD 24 h", () => {
    const o = buildOrder(buy, 1000);
    expect(o).toMatchObject({ tokenId: "yes", side: "BUY", price: 0.456, shares: 10 });
    expect(o.expiresAt.getTime()).toBe(1000 + 24 * 3_600_000);
    expect(buildOrder(sell, 0)).toMatchObject({ tokenId: "no", side: "SELL", price: 0.6 });
    expect(buildOrder({ ...sell, price: 0.4567, tick: 0.001 }, 0).price).toBe(0.457); // SELL rounds up
    expect(buildOrder({ ...buy, price: 0.4567 }, 0).price).toBe(0.456);
  });

  for (const input of [buy, sell]) {
    describe(input.side, () => {
      it("signing -> open: exactly one order on the exchange with this token, side, price, size", async () => {
        const fx = fakeExchange();
        const r = await sendOrder(fx, input, Date.now(), () => {}, nowait, rej);
        expect(r.phase).toMatchObject({ s: "open", shares: input.shares, filled: 0 });
        expect(await fx.openOrders()).toEqual([expect.objectContaining({ tokenId: input.tokenId, side: input.side, price: buildOrder(input, 0).price, shares: input.shares })]);
      });

      it("open -> filled (orderStatus sees the trade) and partial", async () => {
        const fx = fakeExchange();
        const since = Date.now();
        const open = (await sendOrder(fx, input, since, () => {}, nowait, rej)).phase as Extract<Awaited<ReturnType<typeof sendOrder>>["phase"], { s: "open" }>;
        fx.fill(open.orderId, input.shares / 2);
        expect(await orderStatus(fx, open)).toMatchObject({ s: "open", filled: input.shares / 2 });
        fx.fill(open.orderId);
        expect(await orderStatus(fx, open)).toMatchObject({ s: "filled", shares: input.shares });
      });

      it("venue rejection -> error with the venue's message", async () => {
        const fx = fakeExchange();
        fx.failNext("not enough balance");
        expect((await sendOrder(fx, input, Date.now(), () => {}, nowait, rej)).phase).toEqual({ s: "error", msg: "not enough balance" });
        expect(await fx.openOrders()).toEqual([]);
      });

      it("wallet rejection -> idle with a note, nothing sent", async () => {
        const fx = fakeExchange();
        fx.failNext(new Error("User rejected the request"));
        const r = await sendOrder(fx, input, Date.now(), () => {}, nowait, rej);
        expect(r.phase).toEqual({ s: "idle" });
        expect(r.note).toMatchObject({ tone: "muted" });
        expect(await fx.openOrders()).toEqual([]);
      });

      it("unknown outcome: checking fires during the look-up, ends unknown, then recheck finds the order", async () => {
        const fx = fakeExchange();
        let checking = 0;
        const flaky = { ...fx, place: async () => { throw new Error("socket hang up"); } };
        const r = await sendOrder(flaky, input, Date.now(), () => checking++, nowait, rej);
        expect(r.phase).toMatchObject({ s: "unknown", order: { tokenId: input.tokenId, side: input.side } });
        expect(checking).toBe(2); // waits between the 3 look-ups
        const p = r.phase as Extract<typeof r.phase, { s: "unknown" }>;
        expect(await recheckOrder(fx, p)).toMatchObject({ s: "unknown", checking: false });
        await fx.place(p.order); // it had reached the venue after all
        expect(await recheckOrder(fx, p)).toMatchObject({ s: "open" });
      });

      it("unknown outcome that filled on arrival -> filled, never resent", async () => {
        const fx = fakeExchange();
        let placed = 0;
        const ex = { ...fx, place: async (o: Parameters<typeof fx.place>[0]) => { placed++; fx.fill((await fx.place(o)).orderId); throw new Error("timeout"); } };
        expect((await sendOrder(ex, input, Date.now(), () => {}, nowait, rej)).phase).toMatchObject({ s: "filled", shares: input.shares });
        expect(placed).toBe(1);
      });
    });
  }

  it("orderStatus: just placed with no trace waits; later it is cancelled", async () => {
    const fx = fakeExchange();
    const p = { s: "open" as const, orderId: "gone", shares: 5, filled: 0, avg: null, since: 1_000 };
    expect(await orderStatus(fx, p, 5_000)).toBeNull();
    expect(await orderStatus(fx, p, 100_000)).toEqual({ s: "cancelled", shares: 5, filled: 0 });
  });

  it("canPlace: only from idle or error", () => {
    expect(canPlace({ s: "idle" })).toBe(true);
    expect(canPlace({ s: "error", msg: "x" })).toBe(true);
    for (const s of ["signing", "checking"] as const) expect(canPlace({ s })).toBe(false);
    expect(canPlace({ s: "filled", shares: 1, avg: 1, fee: 0 })).toBe(false);
    expect(canPlace({ s: "open", orderId: "o", shares: 1, filled: 0, avg: null, since: 0 })).toBe(false);
  });

  it("sendIfCurrent: result dropped when the exchange changed mid-send, kept otherwise", async () => {
    const fx = fakeExchange();
    expect(await sendIfCurrent(fx, () => fx, buy, Date.now(), () => {}, nowait, rej)).toMatchObject({ phase: { s: "open" } });
    let now: unknown = fx;
    const swap = { ...fx, place: async (o: Parameters<typeof fx.place>[0]) => { now = "other-account"; return fx.place(o); } };
    expect(await sendIfCurrent(swap, () => now, buy, Date.now(), () => {}, nowait, rej)).toBeNull();
  });
});

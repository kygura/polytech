import { describe, expect, it } from "vitest";
import { clobExchange, exchangeFromEnv, fakeExchange, safeError, type LimitOrder } from "./index";

const NOW = new Date("2026-10-17T12:00:00Z");
const KEY = "0x" + "ab12".repeat(16);
const order = (o: Partial<LimitOrder> = {}): LimitOrder => ({
  tokenId: "t1", side: "BUY", price: 0.4, shares: 10, expiresAt: new Date(NOW.getTime() + 15 * 60_000), ...o,
});

describe("placeImmediate (fake)", () => {
  const imm = (o = {}) => ({ tokenId: "t1", side: "BUY" as const, shares: 10, capPrice: 0.5, type: "FOK" as const, ...o });
  it("fills fully by default, moves position/usdc, records trade", async () => {
    const ex = fakeExchange({ usdc: 100, now: () => NOW });
    const r = await ex.placeImmediate(imm());
    expect(r).toMatchObject({ status: "filled", filledShares: 10, avgPrice: 0.5, clobOrderId: "fake-1" });
    expect(await ex.positions()).toEqual({ t1: 10 });
    expect((await ex.balance()).usdc).toBeCloseTo(95);
    expect((await ex.trades(NOW)).length).toBe(1);
  });
  it("scripted: kill, FAK partial, FOK partial = killed, one-shot per token", async () => {
    const ex = fakeExchange({ now: () => NOW });
    ex.scriptImmediate("t1", 0);
    expect(await ex.placeImmediate(imm())).toEqual({ status: "killed", filledShares: 0, avgPrice: 0 });
    ex.scriptImmediate("t1", 4);
    expect(await ex.placeImmediate(imm({ type: "FAK" }))).toMatchObject({ status: "partial", filledShares: 4 });
    ex.scriptImmediate("t1", 4);
    expect((await ex.placeImmediate(imm())).status).toBe("killed");
    expect(await ex.positions()).toEqual({ t1: 4 });
    expect((await ex.placeImmediate(imm())).status).toBe("filled");
  });
  it("failNext rejects (string) or throws (Error); validates cap", async () => {
    const ex = fakeExchange({ now: () => NOW });
    ex.failNext("nope");
    expect(await ex.placeImmediate(imm())).toMatchObject({ status: "rejected", error: "nope" });
    ex.failNext(new Error("boom"));
    await expect(ex.placeImmediate(imm())).rejects.toThrow("boom");
    for (const bad of [{ capPrice: 0 }, { capPrice: 1 }, { shares: 0 }, { type: "GTC" }]) await expect(ex.placeImmediate(imm(bad))).rejects.toThrow(/immediate:/);
  });
});

describe("fakeExchange", () => {
  it("place -> live, fill -> trade + position + usdc, order leaves book when fully filled", async () => {
    const ex = fakeExchange({ usdc: 100, now: () => NOW });
    const p = await ex.place(order());
    expect(p).toEqual({ orderId: "fake-1", status: "live" });
    ex.fill(p.orderId, 4);
    expect(await ex.openOrders()).toEqual([{ orderId: "fake-1", tokenId: "t1", side: "BUY", price: 0.4, shares: 10, filled: 4 }]);
    ex.fill(p.orderId, undefined, 0.39);
    expect(await ex.openOrders()).toEqual([]);
    expect(await ex.positions()).toEqual({ t1: 10 });
    expect((await ex.balance()).usdc).toBeCloseTo(100 - 4 * 0.4 - 6 * 0.39);
    const ts = await ex.trades(NOW);
    expect(ts.map((t) => [t.orderId, t.shares, t.price])).toEqual([["fake-1", 4, 0.4], ["fake-1", 6, 0.39]]);
    expect(await ex.trades(new Date(NOW.getTime() + 1))).toEqual([]);
    expect(() => ex.fill(p.orderId)).toThrow(/no open order/);
  });

  it("sell fill reduces position and credits usdc; setBalance overrides", async () => {
    const ex = fakeExchange({ now: () => NOW });
    ex.setBalance(5);
    const p = await ex.place(order({ side: "SELL", price: 0.6 }));
    ex.fill(p.orderId, 10);
    expect(await ex.positions()).toEqual({ t1: -10 });
    expect((await ex.balance()).usdc).toBeCloseTo(11);
  });

  it("validates before sending: price range, shares, expiry >= now+3min", async () => {
    const ex = fakeExchange({ now: () => NOW });
    for (const bad of [{ price: 0 }, { price: 1 }, { price: 1.2 }, { shares: 0 }, { shares: -1 }, { expiresAt: new Date(NOW.getTime() + 2 * 60_000) }])
      await expect(ex.place(order(bad))).rejects.toThrow(/order:/);
    expect(await ex.openOrders()).toEqual([]);
    await expect(ex.place(order({ expiresAt: new Date(NOW.getTime() + 3 * 60_000) }))).resolves.toMatchObject({ status: "live" });
  });

  it("failNext: string rejects a place, Error throws; one-shot", async () => {
    const ex = fakeExchange({ now: () => NOW });
    ex.failNext("insufficient balance");
    expect(await ex.place(order())).toEqual({ orderId: "", status: "rejected", error: "insufficient balance" });
    ex.failNext(new Error("boom"));
    await expect(ex.cancelAll()).rejects.toThrow("boom");
    expect((await ex.place(order())).status).toBe("live");
  });

  it("cancel / cancelAll clear open orders", async () => {
    const ex = fakeExchange({ now: () => NOW });
    const a = await ex.place(order());
    await ex.place(order());
    await ex.cancel([a.orderId]);
    expect((await ex.openOrders()).length).toBe(1);
    await ex.cancelAll();
    expect(await ex.openOrders()).toEqual([]);
  });
});

describe("key safety", () => {
  it("safeError strips private keys (0x and bare), api secrets, and drops cause/fields", () => {
    const sdkErr = Object.assign(new Error(`RequestRejectedError: 400 signer ${KEY} key=${KEY.slice(2)} secret=s3cr3tSecretValue pass=PassPhrase123`), {
      cause: { privateKey: KEY }, config: { headers: { POLY_PASSPHRASE: "PassPhrase123" } },
    });
    const e = safeError(sdkErr, [KEY.slice(2), "s3cr3tSecretValue", "PassPhrase123"]);
    const dump = `${e.message} ${e.stack} ${JSON.stringify(e)} ${String(e)} ${JSON.stringify(Object.getOwnPropertyDescriptors(e))}`;
    expect(dump).not.toMatch(/ab12ab12/);
    expect(dump).not.toContain("s3cr3tSecretValue");
    expect(dump).not.toContain("PassPhrase123");
    expect(e.message).toContain("400");
    expect(e.cause).toBeUndefined();
  });

  it("clobExchange: missing key -> clear error; bad key -> error without the key; valid key not exposed on the object", () => {
    expect(() => clobExchange({})).toThrow("PM_PRIVATE_KEY not set");
    const bad = "0x" + "zz".repeat(32);
    expect(() => clobExchange({ PM_PRIVATE_KEY: bad })).toThrow(/32-byte hex/);
    try { clobExchange({ PM_PRIVATE_KEY: bad }); } catch (e) { expect(String((e as Error).message)).not.toContain(bad); }
    expect(() => clobExchange({ PM_PRIVATE_KEY: KEY, PM_SIGNATURE_TYPE: "proxy" })).toThrow();
    const ex = clobExchange({ PM_PRIVATE_KEY: KEY, PM_SIGNATURE_TYPE: "eoa" });
    expect(ex.address()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(`${JSON.stringify(ex)} ${String(ex)} ${Object.values(ex).join(" ")}`).not.toMatch(/ab12ab12/);
  });

  it("exchangeFromEnv: null without key or in fixtures mode", () => {
    expect(exchangeFromEnv({})).toBeNull();
    expect(exchangeFromEnv({ PM_PRIVATE_KEY: "" })).toBeNull();
    expect(exchangeFromEnv({ PM_FIXTURES: "1", PM_PRIVATE_KEY: KEY })).toBeNull();
    expect(exchangeFromEnv({ PM_PRIVATE_KEY: KEY })).not.toBeNull();
  });
});

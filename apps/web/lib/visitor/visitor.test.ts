import { describe, expect, it } from "vitest";
import { checkGeoblock } from "./geoblock";
import { visitorExchange } from "./exchange";
import { createTradingKey, exportTradingKey, forgetTradingKey, fundingInfo, importTradingKey, loadTradingKey, STORAGE_KEY, tradingKeyAddress, tradingKeySigner, type KeyStore } from "./tradingKey";
import { isRejection } from "../../hooks/useWallet";
import { resolveFunder } from "./wallet";

const fakeStore = (): KeyStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const reply = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

describe("geoblock", () => {
  it("allowed only on an OK response with blocked: false", async () => {
    expect(await checkGeoblock(reply(200, { blocked: false, ip: "1.2.3.4", country: "BR", region: "SP" }))).toEqual({ blocked: false, country: "BR", region: "SP" });
    expect(await checkGeoblock(reply(200, { blocked: true, country: "US" }))).toEqual({ blocked: true, reason: "blocked", country: "US", region: undefined });
  });
  it("fails closed", async () => {
    const failed = { blocked: true, reason: "check_failed" };
    expect(await checkGeoblock(reply(500, { blocked: false }))).toEqual(failed);
    expect(await checkGeoblock(reply(403, "nope"))).toEqual(failed);
    expect(await checkGeoblock(reply(200, "<html>"))).toEqual(failed);
    expect(await checkGeoblock(reply(200, null))).toEqual(failed);
    expect(await checkGeoblock(reply(200, { blocked: "false" }))).toEqual(failed);
    expect(await checkGeoblock(reply(200, {}))).toEqual(failed);
    expect(await checkGeoblock((async () => { throw new TypeError("CORS"); }) as typeof fetch)).toEqual(failed);
    const hang = ((_u: unknown, i?: RequestInit) => new Promise((_, rej) => i?.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as typeof fetch;
    expect(await checkGeoblock(hang, 10)).toEqual(failed);
  });
});

describe("trading key", () => {
  it("create / load / export / forget roundtrip", () => {
    const s = fakeStore();
    expect(loadTradingKey(s)).toBeNull();
    const pk = createTradingKey(s);
    expect(pk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(loadTradingKey(s)).toBe(pk);
    expect(exportTradingKey(s)).toBe(pk);
    expect(s.m.size).toBe(1);
    expect(() => createTradingKey(s)).toThrow(/already exists/); // never overwrite a funded key
    forgetTradingKey(s);
    expect(loadTradingKey(s)).toBeNull();
  });
  it("import normalizes valid hex, rejects bad input without echoing it", () => {
    const s = fakeStore();
    const raw = "AB".repeat(32);
    expect(importTradingKey(`  ${raw} `, s)).toBe(`0x${raw.toLowerCase()}`);
    expect(() => importTradingKey(raw, s)).toThrow(/already exists/);
    forgetTradingKey(s);
    for (const bad of ["", "0x1234", "zz".repeat(32), "0x" + "00".repeat(32), "ff".repeat(32)]) {
      try {
        importTradingKey(bad, s);
        throw new Error("accepted");
      } catch (e) {
        expect((e as Error).message).not.toBe("accepted");
        if (bad.length > 8) expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(s.m.size).toBe(0);
  });
  it("corrupt stored value loads as null", () => {
    const s = fakeStore();
    s.setItem(STORAGE_KEY, "garbage");
    expect(loadTradingKey(s)).toBeNull();
  });
  it("signer + funding info + exchange from the key, no network", async () => {
    const pk = createTradingKey(fakeStore());
    const addr = tradingKeyAddress(pk);
    const signer = await tradingKeySigner(pk);
    expect(await signer.getAddress()).toBe(addr);
    expect(fundingInfo(pk)).toMatchObject({ address: addr, mode: "eoa" });
    const ex = visitorExchange(signer, addr, { wallet: addr, mode: "eoa" }, [pk]);
    expect(ex.address()).toBe(addr);
    expect(`${JSON.stringify(ex)} ${Object.values(ex).join(" ")}`).not.toContain(pk.slice(2));
  });
});

describe("resolveFunder", () => {
  const eoa = "0x1111111111111111111111111111111111111111" as const;
  it("uses the profile's Polymarket wallet when present, else the EOA", async () => {
    expect(await resolveFunder(eoa, async () => ({ wallet: "0x2222222222222222222222222222222222222222" }))).toEqual({ wallet: "0x2222222222222222222222222222222222222222", mode: "polymarket" });
    expect(await resolveFunder(eoa, async () => null)).toEqual({ wallet: eoa, mode: "eoa" });
    expect(await resolveFunder(eoa, async () => ({ wallet: null }))).toEqual({ wallet: eoa, mode: "eoa" });
  });
  it("rejects when the lookup fails, so a transient error never falls back to EOA", async () => {
    await expect(resolveFunder(eoa, async () => { throw new Error("503"); })).rejects.toThrow("503");
  });
});

describe("isRejection", () => {
  it("matches user rejection only, not venue access denied", () => {
    expect(isRejection({ code: 4001 })).toBe(true);
    expect(isRejection(new Error("User rejected the request."))).toBe(true);
    expect(isRejection(new Error("403 Access denied"))).toBe(false);
  });
});

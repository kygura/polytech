import { describe, expect, it } from "vitest";
import { visitorExchange } from "./exchange";
import { createTradingKey, exportTradingKey, forgetTradingKey, fundingInfo, importTradingKey, loadTradingKey, STORAGE_KEY, tradingKeyAddress, tradingKeySigner, type KeyStore } from "./tradingKey";
import { isRejection } from "../../hooks/useWallet";
import { resolveFunder } from "./wallet";

const fakeStore = (): KeyStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const reply = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

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

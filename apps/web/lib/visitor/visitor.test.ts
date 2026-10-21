import { describe, expect, it } from "vitest";
import { isRejection } from "../../hooks/useWallet";
import { DEFAULT_VISITOR_SETTINGS, loadVisitorSettings, saveVisitorSettings, SETTINGS_KEY } from "./settings";
import { resolveFunder } from "./wallet";

const store = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("visitor settings", () => {
  it("missing / corrupt / invalid -> defaults (manual)", () => {
    const s = store();
    expect(loadVisitorSettings(s)).toEqual(DEFAULT_VISITOR_SETTINGS);
    for (const bad of ["{", "null", JSON.stringify({ ...DEFAULT_VISITOR_SETTINGS, mode: "L9" }), JSON.stringify({ ...DEFAULT_VISITOR_SETTINGS, kelly: 5 }), JSON.stringify({ mode: "L4" })]) {
      s.m.set(SETTINGS_KEY, bad);
      expect(loadVisitorSettings(s)).toEqual(DEFAULT_VISITOR_SETTINGS);
    }
  });
  it("save validates, roundtrips", () => {
    const s = store(), v = { ...DEFAULT_VISITOR_SETTINGS, mode: "L3" as const };
    expect(() => saveVisitorSettings({ ...v, bankroll: -1 }, s)).toThrow();
    expect(s.m.size).toBe(0);
    saveVisitorSettings(v, s);
    expect(loadVisitorSettings(s)).toEqual(v);
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

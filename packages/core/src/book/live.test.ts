import { describe, expect, it } from "vitest";
import { gtdExpiry, livelimitPrice, proposalExpiry, reconcile } from "./live";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe("proposalExpiry", () => {
  const p = { createdAt: t0, priceAtProposal: 0.5 };
  it("timeout at 15 min", () => {
    expect(proposalExpiry(p, at(14), 0.5)).toBeNull();
    expect(proposalExpiry(p, at(15), 0.5)).toBe("TIMEOUT");
  });
  it("price moved only beyond 0.02", () => {
    expect(proposalExpiry(p, at(1), 0.52)).toBeNull();
    expect(proposalExpiry(p, at(1), 0.53)).toBe("PRICE_MOVED");
    expect(proposalExpiry(p, at(1), 0.47)).toBe("PRICE_MOVED");
  });
});

describe("livelimitPrice", () => {
  it("rounds up to tick, float safe", () => {
    expect(livelimitPrice({ vwap: 0.301, pPost: 0.5, tick: 0.01 })).toBe(0.31);
    expect(livelimitPrice({ vwap: 0.3, pPost: 0.5, tick: 0.01 })).toBe(0.3);
    expect(livelimitPrice({ vwap: 0.1 + 0.2, pPost: 0.5, tick: 0.01 })).toBe(0.3);
    expect(livelimitPrice({ vwap: 0.4512, pPost: 0.9, tick: 0.001 })).toBe(0.452);
  });
  it("null when worse than pPost - 0.02", () => {
    expect(livelimitPrice({ vwap: 0.48, pPost: 0.5, tick: 0.01 })).toBe(0.48);
    expect(livelimitPrice({ vwap: 0.481, pPost: 0.5, tick: 0.01 })).toBeNull();
    expect(livelimitPrice({ vwap: NaN, pPost: 0.5, tick: 0.01 })).toBeNull();
  });
});

describe("gtdExpiry", () => {
  it("caps at 24h, null expiry means cap", () => {
    expect(gtdExpiry(null, t0)).toEqual(at(24 * 60));
    expect(gtdExpiry(at(48 * 60), t0)).toEqual(at(24 * 60));
    expect(gtdExpiry(at(60), t0)).toEqual(at(60));
  });
  it("null under 3 min", () => {
    expect(gtdExpiry(at(2), t0)).toBeNull();
    expect(gtdExpiry(at(3), t0)).toEqual(at(3));
  });
});

describe("reconcile", () => {
  const l = { usdc: 100, positions: { a: 5 } };
  it("ok within tolerance", () => expect(reconcile(l, { usdc: 100.005, positions: { a: 5.005 } })).toEqual({ ok: true, mismatches: [] }));
  it("missing key = 0, usdc mismatch", () => {
    const r = reconcile(l, { usdc: 99, positions: { b: 2 } });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([
      { key: "usdc", ledger: 100, exchange: 99 },
      { key: "a", ledger: 5, exchange: 0 },
      { key: "b", ledger: 0, exchange: 2 },
    ]);
  });
  it("NaN fails closed", () => expect(reconcile({ usdc: NaN, positions: {} }, { usdc: 1, positions: {} }).ok).toBe(false));
});

import { describe, expect, it } from "vitest";
import { buttonState, canSwitch, sellable, type ButtonIn } from "./rules";

const base: ButtonIn = {
  loaded: true, noBook: false, gate: null, wallet: "connected", signing: false, allowanceError: null,
  phase: { s: "idle" }, valid: true, armed: false, outcome: "YES", orderText: "Buy 500 YES at 41.2¢", c: (p) => (p * 100).toFixed(1),
};

describe("canSwitch", () => {
  it("blocks only while the order outcome is in flight", () => {
    expect((["signing", "checking", "unknown"] as const).map(canSwitch)).toEqual([false, false, false]);
    expect((["idle", "error", "filled", "cancelled", "open"] as const).map(canSwitch)).toEqual([true, true, true, true, true]);
  });
});

describe("sellable", () => {
  it("held minus the rest of own open SELLs on that token only", () => {
    const orders = [
      { tokenId: "y", side: "SELL" as const, shares: 100, filled: 40 },
      { tokenId: "y", side: "BUY" as const, shares: 50, filled: 0 },
      { tokenId: "n", side: "SELL" as const, shares: 30, filled: 0 },
    ];
    expect(sellable(200, orders, "y")).toBe(140);
    expect(sellable(50, orders, "y")).toBe(0);
    expect(sellable(200, orders, null)).toBe(0);
  });
});

describe("buttonState", () => {
  it("feed first: waiting, then no book", () => {
    expect(buttonState({ ...base, loaded: false, gate: "disconnected" })).toMatchObject({ label: "Waiting for live book…", spin: true, off: true });
    expect(buttonState({ ...base, loaded: false, noBook: true }).line?.text).toBe("No live book for this market.");
  });
  it("gate next: no wallet, blocked region alert, signing step", () => {
    expect(buttonState({ ...base, gate: "disconnected", wallet: "unavailable" })).toMatchObject({ label: "No wallet found", off: true, look: "connect" });
    expect(buttonState({ ...base, gate: "disconnected", wallet: "disconnected" })).toMatchObject({ label: "Connect wallet", off: false, action: "connect" });
    expect(buttonState({ ...base, gate: "geo_blocked" })).toMatchObject({ label: "Trading blocked in your region", off: true, line: { alert: true } });
    expect(buttonState({ ...base, gate: "allowance_needed", signing: true })).toMatchObject({ label: "Confirm in your wallet…", off: true, spin: true });
    expect(buttonState({ ...base, gate: "allowance_checking", allowanceError: "down" }).line).toEqual({ text: "down", link: "retryAllowance" });
  });
  it("phase: idle valid / armed / invalid, open, unknown, error", () => {
    expect(buttonState(base)).toMatchObject({ label: "Buy 500 YES at 41.2¢", kbd: ["⏎"], look: "yes", action: "place", off: false });
    expect(buttonState({ ...base, armed: true })).toMatchObject({ label: "Sign: Buy 500 YES at 41.2¢", kbd: ["⏎", "⌘⏎"] });
    expect(buttonState({ ...base, valid: false })).toMatchObject({ label: "Sign and place order", off: true, action: null });
    expect(buttonState({ ...base, outcome: "NO" }).look).toBe("no");
    expect(buttonState({ ...base, phase: { s: "open", orderId: "0x1234567890", shares: 500, filled: 120, avg: 0.412, since: 0 } }))
      .toMatchObject({ label: "Cancel rest", kbd: ["X"], action: "cancel", line: { text: "Partially filled · 120/500 at 41.2¢" } });
    expect(buttonState({ ...base, phase: { s: "unknown", order: {} as never, since: 0 } })).toMatchObject({ label: "Check open orders", action: "recheck", line: { link: "startOver" } });
    expect(buttonState({ ...base, phase: { s: "error", msg: "x".repeat(100) } }).line?.text).toHaveLength("Order failed: ".length + 80);
    expect(buttonState({ ...base, phase: { s: "signing" } })).toMatchObject({ label: "Confirm in your wallet…", off: true });
  });
});

import { describe, expect, it } from "vitest";
import { countdown, drift, killError, killLabel, reconText, stateText } from "./live";

describe("phase 6 display rules", () => {
  it("countdown warns under 2 min with a glyph", () => {
    expect(countdown(724_000, 0)).toMatchObject({ text: "12:04 left", cls: "" });
    expect(countdown(102_000, 0)).toMatchObject({ text: "⚠ 1:42 left", cls: "warn" });
    expect(countdown(0, 5000).text).toBe("⚠ 0:00 left");
  });

  it("drift warns at 1.5¢ and handles a missing mid", () => {
    expect(drift({ midAtProposal: 0.44, midNow: 0.448 })).toMatchObject({ text: "+0.8", cls: "" });
    expect(drift({ midAtProposal: 0.44, midNow: 0.425 })).toMatchObject({ text: "⚠ −1.5", cls: "warn" });
    expect(drift({ midAtProposal: 0.44, midNow: null }).text).toBe("—");
  });

  it("recent state text", () => {
    expect(stateText({ state: "sent", reason: null, error: null, orderId: "0x3fa1bc99" })).toMatchObject({ text: "sent · ord 0x3fa1…", cls: "pos" });
    expect(stateText({ state: "expired", reason: "PRICE_MOVED", error: null, orderId: null })).toMatchObject({ text: "expired · PRICE_MOVED", cls: "warn" });
    expect(stateText({ state: "expired", reason: "TIMEOUT", error: null, orderId: null }).cls).toBe("muted");
    expect(stateText({ state: "failed", reason: null, error: "x".repeat(80), orderId: null }).text.length).toBe("failed · ".length + 60);
  });

  it("recon: never run, ok, late, mismatch", () => {
    const at = "2026-10-17T14:35:00Z", t = Date.parse(at);
    expect(reconText(null, t).text).toBe("not run yet");
    expect(reconText({ at, status: "ok", detail: null }, t + 120_000)).toMatchObject({ glyph: "✓", cls: "muted" });
    expect(reconText({ at, status: "ok", detail: null }, t + 17 * 60_000)).toMatchObject({ glyph: "⚠", cls: "warn" });
    expect(reconText({ at, status: "mismatch", detail: "position 0x1 ledger 820 vs chain 700" }, t)).toMatchObject({ glyph: "✗", cls: "neg" });
  });

  it("kill result text", () => {
    expect(killLabel({ cancelled: 0, failed: [] })).toBe("KILLED · L0");
    expect(killLabel({ cancelled: 2, failed: [{ orderId: "0x3fa1bc", error: "e" }] })).toBe("KILLED · L0 · 2 cancelled · 1 FAILED");
    expect(killError({ cancelled: 3, failed: [] })).toBeNull();
    expect(killError({ cancelled: 2, failed: [{ orderId: "0x3fa1bc", error: "timeout" }] })).toBe("Kill: 1 live order not cancelled (ord 0x3fa1…: timeout). Cancel it on Polymarket or retry.");
  });
});

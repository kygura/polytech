import { describe, expect, it } from "vitest";
import { approvalChip, countdown, drift, fallbackText, gateParts, killError, killLabel, reconText, setStateText, stateText } from "./live";

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

describe("phase 7 display rules", () => {
  const leg = (state: string) => ({ conditionId: "c", question: "q", token: "YES" as const, capPrice: 0.2, shares: 820, costUsd: 164, state });
  const set = (state: string, legs: string[], x: { failedLeg?: number | null; error?: string | null; held?: number } = {}) =>
    ({ state, legs: legs.map(leg), failedLeg: x.failedLeg ?? null, error: x.error ?? null, held: Array.from({ length: x.held ?? 0 }, () => ({ conditionId: "c", question: "q", token: "YES" as const, shares: 820, avgFill: 0.2, bidNow: 0.19 })) });

  it("set lifecycle text", () => {
    expect(setStateText(set("sending", ["filled", "sending", "queued", "queued", "queued"]))).toMatchObject({ text: "sending leg 2/5…", cls: "muted" });
    expect(setStateText(set("filled", ["filled", "filled"]))).toMatchObject({ text: "filled · 2/2 legs", cls: "pos" });
    expect(setStateText(set("unwinding", ["filled", "filled", "failed"], { failedLeg: 2 }))).toMatchObject({ text: "unwinding · leg 3 failed", cls: "warn" });
    expect(setStateText(set("unwound", ["unwound", "failed"], { failedLeg: 1, error: "FOK killed" })).text).toBe("unwound · leg 2 FOK killed");
    expect(setStateText(set("failed", ["failed"], { failedLeg: 0, error: "no book" }))).toMatchObject({ text: "failed · leg 1 no book", cls: "neg" });
    expect(setStateText(set("flagged", ["held", "held"], { held: 2 }))).toMatchObject({ text: "flagged · 2 legs held", cls: "neg" });
    expect(setStateText(set("acknowledged", []))).toMatchObject({ text: "flagged · acknowledged", cls: "muted" });
  });

  it("approval chip from orders and proposals", () => {
    expect(approvalChip({ approval: "user", modeAtSend: "L3" }).text).toBe("user");
    expect(approvalChip({ approval: "auto", modeAtSend: "L3" })).toEqual({ text: "AUTO L3", color: "var(--mode-3)" });
    expect(approvalChip({ approval: "auto", modeAtSend: "L4" })).toEqual({ text: "AUTO L4", color: "var(--mode-4)" });
    expect(approvalChip({ decidedVia: "auto" }).text).toBe("AUTO");
    expect(approvalChip({ decidedVia: "web" }).text).toBe("user");
  });

  it("L3 fallback text", () => {
    const l3 = { perTradeUsd: 100, dailyNotional: 500 };
    expect(fallbackText("PER_TRADE", 366.54, l3)).toBe("L3 fallback: over L3 per-trade $100 (this $366.54)");
    expect(fallbackText("STRUCTURAL_AUTO_OFF", 0, l3)).toBe("L3 fallback: sets need structural auto (Settings)");
    expect(fallbackText(null, 0, l3)).toBeNull();
  });

  it("gate criteria are met separately", () => {
    const a = gateParts({ gate: "L2->L3", met: false, detail: "", approvedTrades: 12, avgSlippageC: 0.6 })!;
    expect(a.parts).toEqual([{ text: "12/30 approved trades", met: false }, { text: "avg slip +0.6¢ vs ≤ 1.0¢", met: true }]);
    expect(gateParts({ gate: "L2->L3", met: false, detail: "", approvedTrades: 0, avgSlippageC: null })!.parts.map((p) => p.text).join(" · ")).toBe("0/30 approved trades · avg slip —");
    const b = gateParts({ gate: "L3->L4", met: false, detail: "", liveTrades: 12, realizedEdge30dC: 1.4 })!;
    expect(b).toMatchObject({ value: 12, max: 100 });
    expect(b.parts.map((p) => p.text).join(" · ")).toBe("12/100 live trades · realized edge 30d +1.4¢");
    expect(gateParts({ gate: "L1->L2", met: false, detail: "3/50" })).toBeNull();
  });
});

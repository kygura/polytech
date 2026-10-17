import { describe, expect, it } from "vitest";
import { autoDowngrade, effectiveMode, gateProgress, kill, qualifies, requestModeChange } from "./autonomy";

describe("effectiveMode", () => {
  it("override only lowers", () => {
    expect(effectiveMode("L1", "L0")).toBe("L0");
    expect(effectiveMode("L0", "L1")).toBe("L0");
    expect(effectiveMode("L1")).toBe("L1");
    expect(effectiveMode("L3", "L2")).toBe("L2");
  });
});

describe("requestModeChange", () => {
  it("allows L0 <-> L1", () => {
    const r = requestModeChange("L0", "L1", "user", "start paper");
    expect(r.allowed).toBe(true);
    expect(r.mode).toBe("L1");
    expect(r.event).toMatchObject({ fromMode: "L0", toMode: "L1", actor: "user", refused: false, skippedGate: false });
  });
  it("refuses any raise to L2+ with EXECUTION_DISABLED but still emits the event", () => {
    for (const to of ["L2", "L3", "L4"] as const) {
      const r = requestModeChange("L1", to, "user", "go live");
      expect(r.allowed).toBe(false);
      expect(r.mode).toBe("L1");
      expect(r.event).toMatchObject({ fromMode: "L1", toMode: to, refused: true, reason: "EXECUTION_DISABLED", note: "go live" });
    }
  });
  it("allows L2-L4 only with a configured exchange", () => {
    expect(requestModeChange("L1", "L2", "user", "go", true, true)).toMatchObject({ allowed: true, mode: "L2" });
    for (const to of ["L3", "L4"] as const) expect(requestModeChange("L2", to, "user", "go", true, true)).toMatchObject({ allowed: true, mode: to });
  });
  it("flags skipped gate on upward moves", () => {
    expect(requestModeChange("L1", "L2", "user", "x", false).event.skippedGate).toBe(true);
    expect(requestModeChange("L1", "L2", "user", "x", true).event.skippedGate).toBe(false);
    expect(requestModeChange("L1", "L0", "user", "x", false).event.skippedGate).toBe(false);
  });
  it("lowering is never refused, even to L2", () => {
    expect(requestModeChange("L3", "L2", "auto-downgrade", "stale").allowed).toBe(true);
  });
});

describe("kill", () => {
  it("drops to L0", () => {
    const r = kill("L1");
    expect(r.mode).toBe("L0");
    expect(r.allowed).toBe(true);
    expect(r.event).toMatchObject({ fromMode: "L1", toMode: "L0", actor: "kill" });
  });
});

describe("gateProgress", () => {
  it("L1->L2: 50 resolved and brier strictly below market", () => {
    expect(gateProgress("L1->L2", { resolved: 50, brier: 0.18, marketBrier: 0.2 }).met).toBe(true);
    expect(gateProgress("L1->L2", { resolved: 49, brier: 0.18, marketBrier: 0.2 }).met).toBe(false);
    expect(gateProgress("L1->L2", { resolved: 50, brier: 0.2, marketBrier: 0.2 }).met).toBe(false);
    expect(gateProgress("L1->L2", { resolved: 49, brier: 0.18, marketBrier: 0.2 }).detail).toContain("49/50");
  });
  it("L2->L3: 30 trades and |slippage| <= 1c", () => {
    expect(gateProgress("L2->L3", { approvedLiveTrades: 30, avgSlippage: 0.01 }).met).toBe(true);
    expect(gateProgress("L2->L3", { approvedLiveTrades: 30, avgSlippage: 0.011 }).met).toBe(false);
    expect(gateProgress("L2->L3", { approvedLiveTrades: 29, avgSlippage: 0 }).met).toBe(false);
  });
  it("L3->L4: 100 trades and positive 30d realized edge", () => {
    expect(gateProgress("L3->L4", { liveTrades: 100, realizedEdge30d: 0.001 }).met).toBe(true);
    expect(gateProgress("L3->L4", { liveTrades: 100, realizedEdge30d: 0 }).met).toBe(false);
    expect(gateProgress("L3->L4", { liveTrades: 99, realizedEdge30d: 0.1 }).met).toBe(false);
  });
  it("missing stats are not met", () => {
    expect(gateProgress("L1->L2", {}).met).toBe(false);
  });
});

describe("autoDowngrade", () => {
  const ok = { dailyLossHit: false, consecutiveOrderErrors: 0, bookStaleMs: 0, balanceMismatch: false, anthropicOutageMidPod: false };
  it("no signal -> null", () => expect(autoDowngrade(ok, "L3")).toBeNull());
  it("daily loss and 3 errors -> L0", () => {
    expect(autoDowngrade({ ...ok, dailyLossHit: true }, "L3")).toMatchObject({ mode: "L0", reason: "DAILY_LOSS_LIMIT" });
    expect(autoDowngrade({ ...ok, consecutiveOrderErrors: 3 }, "L4")).toMatchObject({ mode: "L0", reason: "ORDER_ERRORS" });
    expect(autoDowngrade({ ...ok, consecutiveOrderErrors: 2 }, "L4")).toBeNull();
  });
  it("stale > 5 min, balance mismatch, outage -> L2", () => {
    expect(autoDowngrade({ ...ok, bookStaleMs: 300_001 }, "L3")).toMatchObject({ mode: "L2", reason: "BOOK_STALE" });
    expect(autoDowngrade({ ...ok, bookStaleMs: 300_000 }, "L3")).toBeNull();
    expect(autoDowngrade({ ...ok, balanceMismatch: true }, "L3")).toMatchObject({ mode: "L2", reason: "BALANCE_MISMATCH" });
    expect(autoDowngrade({ ...ok, anthropicOutageMidPod: true }, "L3")).toMatchObject({ mode: "L2", reason: "ANTHROPIC_OUTAGE" });
  });
  it("L0 triggers win over L2 triggers", () => {
    expect(autoDowngrade({ ...ok, bookStaleMs: 999_999, dailyLossHit: true }, "L3")?.mode).toBe("L0");
  });
  it("never raises: target >= current -> null", () => {
    expect(autoDowngrade({ ...ok, bookStaleMs: 999_999 }, "L1")).toBeNull();
    expect(autoDowngrade({ ...ok, bookStaleMs: 999_999 }, "L2")).toBeNull();
    expect(autoDowngrade({ ...ok, dailyLossHit: true }, "L0")).toBeNull();
  });
});

describe("qualifies", () => {
  const th = { edge: 0.03, confidence: 0.5, disagreementCapTripped: false };
  const ctx = { categoryThreshold: 0.4, bookAgeMs: 59_999, pass1: true };
  it("passes when all hold", () => expect(qualifies(th, ctx)).toEqual({ ok: true, failed: [] }));
  it("edge >= 0.02 inclusive", () => {
    expect(qualifies({ ...th, edge: 0.02 }, ctx).ok).toBe(true);
    expect(qualifies({ ...th, edge: 0.0199 }, ctx).failed).toEqual(["EDGE"]);
  });
  it("confidence must be strictly above threshold", () => {
    expect(qualifies({ ...th, confidence: 0.4 }, ctx).failed).toEqual(["CONFIDENCE"]);
  });
  it("disagreement cap, stale book (>= 60s), pass1", () => {
    expect(qualifies({ ...th, disagreementCapTripped: true }, ctx).failed).toEqual(["DISAGREEMENT"]);
    expect(qualifies(th, { ...ctx, bookAgeMs: 60_000 }).failed).toEqual(["BOOK_STALE"]);
    expect(qualifies(th, { ...ctx, pass1: false }).failed).toEqual(["PASS1"]);
  });
  it("collects all failures", () => {
    expect(qualifies({ edge: 0, confidence: 0, disagreementCapTripped: true }, { ...ctx, pass1: false }).failed).toHaveLength(4);
  });
});

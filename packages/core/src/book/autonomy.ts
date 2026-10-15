import { MODES, type Actor, type Mode } from "./types";

const rank = (m: Mode): number => MODES.indexOf(m);

/** Category override can only lower autonomy. */
export function effectiveMode(global: Mode, categoryOverride?: Mode): Mode {
  return categoryOverride && rank(categoryOverride) < rank(global) ? categoryOverride : global;
}

export interface AutonomyEvent {
  fromMode: Mode;
  toMode: Mode;
  actor: Actor;
  reason: string; // "EXECUTION_DISABLED" when refused
  note?: string; // caller's reason when refused
  refused: boolean;
  skippedGate: boolean;
}
export interface ModeChange {
  allowed: boolean;
  mode: Mode; // resulting mode
  event: AutonomyEvent; // always produced; log refused ones too
}

/**
 * Build 1 refuses every raise to L2+ (execution disabled). Lowering or keeping the mode is
 * always allowed (so a persisted L3 can still be downgraded to L2).
 * gateMet=false on an upward move is recorded as skippedGate (gates are advisory).
 */
export function requestModeChange(from: Mode, to: Mode, actor: Actor, reason: string, gateMet = true): ModeChange {
  const up = rank(to) > rank(from);
  const refused = up && rank(to) >= rank("L2");
  const event: AutonomyEvent = {
    fromMode: from, toMode: to, actor,
    reason: refused ? "EXECUTION_DISABLED" : reason,
    refused,
    skippedGate: up && !gateMet,
  };
  if (refused) event.note = reason;
  return { allowed: !refused, mode: refused ? from : to, event };
}

export const kill = (from: Mode): ModeChange => requestModeChange(from, "L0", "kill", "KILL_SWITCH");

export type Gate = "L1->L2" | "L2->L3" | "L3->L4";
export interface GateStats {
  resolved?: number;
  brier?: number;
  marketBrier?: number;
  approvedLiveTrades?: number;
  avgSlippage?: number; // realized - modeled k(S), per share
  liveTrades?: number;
  realizedEdge30d?: number;
}

/** Advisory only: nothing blocks a mode change on this. */
export function gateProgress(gate: Gate, s: GateStats): { met: boolean; detail: string } {
  if (gate === "L1->L2") {
    const n = s.resolved ?? 0;
    const beats = s.brier !== undefined && s.marketBrier !== undefined && s.brier < s.marketBrier;
    return { met: n >= 50 && beats, detail: `resolved ${n}/50; brier ${s.brier ?? "n/a"} vs market ${s.marketBrier ?? "n/a"}` };
  }
  if (gate === "L2->L3") {
    const n = s.approvedLiveTrades ?? 0;
    const close = s.avgSlippage !== undefined && Math.abs(s.avgSlippage) <= 0.01 + 1e-9;
    return { met: n >= 30 && close, detail: `approved trades ${n}/30; avg slippage ${s.avgSlippage ?? "n/a"} (need within 0.01)` };
  }
  const n = s.liveTrades ?? 0;
  const pos = (s.realizedEdge30d ?? 0) > 0;
  return { met: n >= 100 && pos, detail: `live trades ${n}/100; 30d realized edge ${s.realizedEdge30d ?? "n/a"} (need > 0)` };
}

export interface DowngradeSignals {
  dailyLossHit: boolean;
  consecutiveOrderErrors: number;
  bookStaleMs: number;
  balanceMismatch: boolean;
  anthropicOutageMidPod: boolean;
}

/** SPEC: L0 for the first two triggers, L2 for the rest. null when nothing fires or it would not lower `current`. */
export function autoDowngrade(s: DowngradeSignals, current: Mode): { mode: Mode; reason: string } | null {
  const hit: { mode: Mode; reason: string } | null =
    s.dailyLossHit ? { mode: "L0", reason: "DAILY_LOSS_LIMIT" }
    : s.consecutiveOrderErrors >= 3 ? { mode: "L0", reason: "ORDER_ERRORS" }
    : s.bookStaleMs > 300_000 ? { mode: "L2", reason: "BOOK_STALE" }
    : s.balanceMismatch ? { mode: "L2", reason: "BALANCE_MISMATCH" }
    : s.anthropicOutageMidPod ? { mode: "L2", reason: "ANTHROPIC_OUTAGE" }
    : null;
  return hit && rank(hit.mode) < rank(current) ? hit : null;
}

export interface QualThesis {
  edge: number; // e(S)
  confidence: number;
  disagreementCapTripped: boolean;
}
export interface QualCtx {
  categoryThreshold: number;
  bookAgeMs: number;
  pass1: boolean; // market still passes Pass 1 filters
}

export function qualifies(t: QualThesis, c: QualCtx): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  if (t.edge < 0.02 - 1e-9) failed.push("EDGE");
  if (t.confidence <= c.categoryThreshold) failed.push("CONFIDENCE");
  if (t.disagreementCapTripped) failed.push("DISAGREEMENT");
  if (c.bookAgeMs >= 60_000) failed.push("BOOK_STALE");
  if (!c.pass1) failed.push("PASS1");
  return { ok: failed.length === 0, failed };
}

import { SCOUT_KICK_MS } from "../lib/cadence";
import { hms } from "./fmt";
import type { SseStatus } from "./SseIndicator";

// DESIGN 12.1.5: pure helpers behind the status bar and the SSE indicator.
export const SNAPSHOT_CADENCE_MS = SCOUT_KICK_MS; // the snapshot step runs with every scout kick
export const SWEEP_CADENCE_MS = 24 * 3_600_000;
export const RETRY_S = 3; // EventSource's default reconnect delay; the countdown is an estimate

export type OpStatus = {
  runs: number; pods: string[];
  spendUsd: number | null; capUsd: number | null;
  snapshotAt: number | null; sweepAt: number | null;
  unacked: number;
};

const ms = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** GET /api/status -> OpStatus. `activeRuns` may be a count or a `{id, stage, question}[]` list (then `activeRunCount`, when present, is the true total); timestamps may be epoch ms or ISO. Anything unusable -> null. */
export function parseStatus(raw: unknown): OpStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.activeRuns) ? (r.activeRuns as Record<string, unknown>[]) : null;
  const spend = (r.spendToday ?? {}) as Record<string, unknown>;
  return {
    runs: num(r.activeRunCount) ?? (list ? list.length : (num(r.activeRuns) ?? 0)),
    pods: (list ?? []).map((p) => `${String(p.id ?? "").slice(0, 8)} · ${p.stage ?? "?"} · ${p.question ?? ""}`),
    spendUsd: num(spend.usd) ?? num(r.spendTodayUsd),
    capUsd: num(spend.capUsd) ?? num(r.dailyCapUsd),
    snapshotAt: ms(r.lastSnapshotAt), sweepAt: ms(r.lastSweepAt),
    unacked: num(r.unackedAlerts) ?? 0,
  };
}

export function fmtAge(age: number | null): string {
  if (age == null) return "—";
  const s = Math.max(0, Math.floor(age / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export type Tone = "text" | "warn" | "neg" | "muted";
/** `--text` under 2x cadence, `--warn` up to 6x, `--neg` beyond; unknown age is muted. */
export const ageTone = (age: number | null, cadence: number): Tone => (age == null ? "muted" : age < 2 * cadence ? "text" : age <= 6 * cadence ? "warn" : "neg");

const usd = (v: number) => `$${v.toFixed(2)}`;
/** Spend segment: `spend $4.12 / $25.00`, or `cap reached $25.40 / $25.00` at/over the cap (fill colours come from MeterBar: accent < 80 %, warn >= 80 %, neg >= 100 %). */
export function spendLabel(spent: number | null, cap: number | null): { text: string; capped: boolean } {
  if (spent == null) return { text: "spend —", capped: false };
  if (cap == null || cap <= 0) return { text: `spend ${usd(spent)}`, capped: false };
  const capped = spent >= cap;
  return { text: `${capped ? "cap reached" : "spend"} ${usd(spent)} / ${usd(cap)}`, capped };
}

/** Trading-mode segment: the viewer's own trades (useTradingMode). Live reads upper-case and warns, so it never relies on colour. */
export const tradingLabel = (m: "paper" | "live") => (m === "live" ? { text: "LIVE", warn: true } : { text: "paper", warn: false });

export function runsLabel(runs: number): string { return runs > 0 ? `runs ${runs} active` : "runs idle"; }

/** `live · 14:02:11`, `reconnecting · 3s`, `offline · retrying` (DESIGN 12.1.1). */
export function sseDetail(status: SseStatus, lastEventAt: number | null, retryIn: number): string {
  if (status === "live") return lastEventAt ? ` · ${hms(lastEventAt)}` : "";
  return status === "reconnecting" ? ` · ${retryIn}s` : " · retrying";
}

/** Next countdown value: RETRY_S -> ... -> 1 -> RETRY_S (a new attempt starts). */
export const nextRetry = (s: number) => (s <= 1 ? RETRY_S : s - 1);

const p2 = (n: number) => String(n).padStart(2, "0");
export const utcClock = (t: number) => { const d = new Date(t); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`; };

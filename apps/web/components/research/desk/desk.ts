// Pure helpers for the research desk: run progress and wording, start-queue steps, triage display. No React.
import { ruleText } from "../../../lib/triageRules";
import type { read } from "../../../lib/jobs";

export type Live = Awaited<ReturnType<typeof read.researchLive>>;
export type Run = Live["runs"][number];
export type Budget = Live["budget"];
export type Stage = NonNullable<Run["stage"]>;
/** One row of /api/research/triage (createdAt is an ISO string over JSON). */
export type Verdict = { conditionId: string; verdict: "research" | "skip"; score: number; reason: string; failedRules: string[]; model: string | null; createdAt: string };
export type QItem = { id: string; question: string };
export type NotStarted = QItem & { reason: string; at: number };

export const TRIAGE_CAP = 50;
export const POLL_BUSY_MS = 3_000;
export const POLL_IDLE_MS = 20_000;

const STAGE_PCT: Record<Exclude<Stage, "agents">, number> = { rules: 10, judge: 80, sizing: 92, done: 100 };

/** Bar width 0..100 from the stage; failed / cancelled runs stay where they stopped. Agents count finished ones (ok or failed). */
export function progress(r: Pick<Run, "status" | "stage" | "agents">): number {
  if (r.status === "done") return 100;
  if (r.stage === "agents") return Math.round(15 + 55 * Math.min(1, (r.agents.done + r.agents.failed) / Math.max(1, r.agents.total)));
  return (r.stage && STAGE_PCT[r.stage as keyof typeof STAGE_PCT]) || 5;
}

/** Stage in words for a running pod. */
export function stageText(r: Pick<Run, "stage" | "agents">): string {
  switch (r.stage) {
    case "rules": return "Reading the rules";
    case "agents": return `Analysts researching · ${r.agents.done}/${r.agents.total} done${r.agents.failed ? ` · ${r.agents.failed} failed` : ""}`;
    case "judge": return "Judge weighing the evidence";
    case "sizing": return "Sizing the trade";
    case "done": return "Done";
    default: return "Starting";
  }
}

/** pods.error in plain words: `TIMEOUT: …`, `ANTHROPIC_OUTAGE: …`, `POD_FAILED: 5/5 agents failed: a | b`, `ERROR: …`. */
export function failText(error: string | null): string {
  if (!error) return "Failed";
  if (error.startsWith("TIMEOUT")) return "Ran out of time";
  if (error.startsWith("ANTHROPIC_OUTAGE")) return "Anthropic API overloaded";
  const m = /^POD_FAILED: (\d+)\/(\d+) agents failed: (.*)$/s.exec(error);
  if (m) return `${m[1]} of ${m[2]} analysts failed: ${m[3]!.split(" | ")[0]}`;
  const k = /^[A-Z_]+: (.*)$/s.exec(error);
  return k ? k[1]! : error;
}

/** 409 `reason` from POST /api/markets/[id]/research in plain words. */
export function skipText(reason: string): string {
  switch (reason) {
    case "MAX_CONCURRENT_SANDBOXES": return "all run slots are busy";
    case "DAILY_SPEND_CAP": return "today's spend cap is reached (Settings → Research budget)";
    case "MAX_PODS_PER_DAY": return "today's run limit is reached (Settings → Research budget)";
    case "RESEARCH_DISABLED": return "research is disabled on this server";
    case "NO_BOOK": return "no order book to trade against";
    case "LOCKED": return "already being researched";
    default: return reason.toLowerCase().replaceAll("_", " ");
  }
}

export const triggerText = (t: string) => (t === "manual" ? "manual" : t === "profile" ? "profile" : `screener · ${t}`);

const c = (p: number) => `${Math.round(p * 100)}¢`;
const signedC = (x: number) => { const r = Math.round(x * 10) / 10; return `${r < 0 ? "−" : "+"}${Math.abs(r)}¢`; };

/** One line for a finished run: fair value vs the price at research, edge, size; or why nothing is traded. */
export function resultText(r: Pick<Run, "verdict" | "judge">): string {
  const v = r.verdict;
  if (v) {
    const fair = v.pYes != null ? `Fair value ${c(v.pYes)}${v.midAtThesis != null ? ` vs ${c(v.midAtThesis)} at research` : ""} · ` : "";
    return `${fair}Edge ${signedC(v.edgeC)} on ${v.side} · Suggested $${Math.round(v.sizeUsd)}`;
  }
  if (r.judge?.pYes != null) return `Fair value ${c(r.judge.pYes)} — no edge worth trading`;
  return "No fair value recorded";
}

/** Short form for the market table's last-result cell. */
export function lastText(r: Pick<Run, "status" | "stage" | "agents" | "verdict" | "judge">): string {
  if (r.status === "running") return `Running ${progress(r)}%`;
  if (r.status === "failed") return "Failed";
  if (r.status === "cancelled") return "Cancelled";
  if (r.verdict) return `Edge ${signedC(r.verdict.edgeC)} ${r.verdict.side}`;
  return r.judge?.pYes != null ? `Fair ${c(r.judge.pYes)} · no edge` : "No edge";
}

export const mss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Triage badge: label, tone, and the tooltip (reason plus failed rules in words). */
export function triageBadge(v: Verdict | undefined): { text: string; tone: "up" | "muted"; why: string } | null {
  if (!v) return null;
  const rules = v.failedRules.map(ruleText);
  const why = rules.length ? rules.join("\n") : v.reason;
  return v.verdict === "research" ? { text: `Worth researching ${v.score.toFixed(1)}`, tone: "up", why } : { text: "Skip", tone: "muted", why };
}

/** Free run slots: the server's count plus starts not yet visible in the poll. */
export const freeSlots = (b: Pick<Budget, "running" | "maxRunning"> | null, pending: number) => (b ? Math.max(0, b.maxRunning - b.running - pending) : 0);

/** One queue step: which queued markets to start now. `held` = the last start hit MAX_CONCURRENT_SANDBOXES and the poll has not moved since. */
export function pump(queue: QItem[], free: number, held: boolean): { start: QItem[]; rest: QItem[] } {
  const n = held ? 0 : Math.min(free, queue.length);
  return { start: queue.slice(0, n), rest: queue.slice(n) };
}

export type StartOutcome = { kind: "started" } | { kind: "requeue" } | { kind: "not_started"; reason: string };

/** POST result -> what the queue does with the market. */
export function startOutcome(status: number | null, j: { error?: string; reason?: string } | null): StartOutcome {
  if (status === 202) return { kind: "started" };
  if (status === 409 && j?.reason === "MAX_CONCURRENT_SANDBOXES") return { kind: "requeue" };
  if (status === 409) return { kind: "not_started", reason: skipText(j?.reason ?? "") };
  if (status === 404) return { kind: "not_started", reason: "market is not tracked" };
  if (status == null) return { kind: "not_started", reason: "network error" };
  return { kind: "not_started", reason: j?.error ?? `HTTP ${status}` };
}

/**
 * Starts sent but not yet seen in the live poll. A start is seen once the poll holds a run for that market that began after it was sent
 * (2 s clock slack), or after 60 s (the pod row may never appear).
 */
export function unseen<P extends { id: string; at: number }>(pending: P[], runs: Pick<Run, "conditionId" | "startedAt">[], now: number) {
  return pending.filter((p) => now - p.at < 60_000 && !runs.some((r) => r.conditionId === p.id && r.startedAt >= p.at - 2_000));
}

/** The highest-volume `n` of `rows`. */
export const topByVolume = <T extends { conditionId: string; vol24h: number | null }>(rows: T[], n = TRIAGE_CAP) =>
  [...rows].sort((a, b) => (b.vol24h ?? 0) - (a.vol24h ?? 0)).slice(0, n);

export const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

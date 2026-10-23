// Pure "Our view" logic (the fair value strip): what state research is in for this market, its progress, plain-words reasons. No React.
import { takerFeePerShare } from "@pm/core";
import type { Outcome } from "./book";

export type Stage = "rules" | "agents" | "judge" | "sizing" | "done" | null;
/** One row of GET /api/research/live (lib/jobs/read.ts researchLive). */
export type LiveRun = {
  podId: string; conditionId: string; status: "running" | "done" | "failed" | "cancelled"; stage: Stage; error: string | null; startedAt: number;
  agents: { total: number; done: number; failed: number };
  verdict: { side: Outcome; pYes: number | null; midAtThesis: number | null; edgeC: number; sizeUsd: number; confidence: number; thesis: string | null } | null;
  judge: { pYes: number | null; thesis: string | null } | null;
};
export type LiveResp = { budget?: { running: number; maxRunning: number }; runs: LiveRun[] };

/** Progress bar percent by stage: rules 10, agents 15 + 55·done/total, judge 80, sizing 92, done 100. */
export function researchPct(stage: Stage, done = 0, total = 0): number {
  switch (stage) {
    case "rules": return 10;
    case "agents": return Math.round(15 + 55 * (total > 0 ? Math.min(1, done / total) : 0));
    case "judge": return 80;
    case "sizing": return 92;
    case "done": return 100;
    default: return 5;
  }
}

/** Elapsed seconds as `1:42` (`12:05`, `1:02:09` past an hour). */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 409 skip reasons from POST /api/markets/[id]/research, in plain words. */
export const REFUSAL: Record<string, string> = {
  MAX_CONCURRENT_SANDBOXES: "Too many research runs going at once — try again when one finishes",
  DAILY_SPEND_CAP: "Daily research budget used up (Settings → Research budget)",
  MAX_PODS_PER_DAY: "Daily limit of research runs reached (Settings → Research budget)",
  RESEARCH_DISABLED: "Research is off on this server: ANTHROPIC_API_KEY is not set",
  NO_BOOK: "No live order book for this market, so there is no price to compare against",
  LOCKED: "Research is already starting for this market",
};
export function refusalText(reason: string | null | undefined, fallback?: string, budget?: LiveResp["budget"]): string {
  if (reason === "MAX_CONCURRENT_SANDBOXES" && budget?.running) return `${budget.running} ${budget.running === 1 ? "run" : "runs"} already going — try again when one finishes`;
  return (reason && REFUSAL[reason]) ?? (fallback ? sentence(fallback.replace(/^research not started:\s*/i, "")) : "Research did not start");
}

/** A failed pod's stored error (`REASON: detail`) in plain words; the raw text goes in a tooltip. */
export function failText(error: string | null | undefined): string {
  const e = error ?? "";
  if (!e) return "the run stopped before it finished (the server restarted or timed out)";
  if (e.startsWith("ANTHROPIC_OUTAGE")) return "the AI provider was unavailable";
  if (e.startsWith("TIMEOUT")) return "it took too long and was stopped";
  const m = /(\d+)\/(\d+) agents failed/.exec(e);
  if (m) return `${m[1]} of ${m[2]} analysts failed`;
  if (e.startsWith("POD_FAILED")) return "the analysts could not finish";
  return "an unexpected error";
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Server messages are lower-case fragments (`no sellers on the book`): capitalise for a line of their own. */
export const plain = sentence;

/** What the strip shows. `thesis` = sized trade; `judge` = researched, no trade cleared sizing. */
export type ViewState =
  | { k: "none" }
  | { k: "running"; podId: string | null; startedAt: number; stage: Stage; pct: number; done: number; total: number }
  | { k: "failed"; error: string | null }
  | { k: "cancelled" }
  | { k: "thesis"; pYes: number; side: Outcome; sizeUsd: number; edgeC: number; at: number }
  | { k: "judge"; pYes: number; at: number };

type Thesis = { podId: string | null; createdAt: number; side: Outcome; pHat: number; pYes?: number | null; edgeC: number; sizeUsd: number } | null;
type Pod = { id: string; status: string; startedAt: number } | null;
type Agent = { role: string; probability: number | null };

/** YES-space fair value of a thesis (older rows have no pYes: pHat is on the thesis side). */
export const thesisYes = (t: NonNullable<Thesis>) => t.pYes ?? (t.side === "YES" ? t.pHat : 1 - t.pHat);

/**
 * The newest run decides: running > failed/cancelled (when newer than the thesis) > done without a thesis (judge only) > thesis > none.
 * `run` is the live poll's latest row for this market (may lag or be absent); `pod`/`thesis`/`agents` come from the market detail.
 */
export function viewState(o: { thesis: Thesis; pod: Pod; agents: Agent[]; run: LiveRun | null }): ViewState {
  const { thesis: t, pod, run } = o;
  const latest = run && (!pod || run.startedAt >= pod.startedAt) ? run : null;
  const status = latest?.status ?? pod?.status ?? null, startedAt = latest?.startedAt ?? pod?.startedAt ?? 0;
  const newer = !t || startedAt > t.createdAt;
  if (status === "running") {
    const a = latest?.agents ?? { total: 0, done: 0 };
    return { k: "running", podId: latest?.podId ?? pod?.id ?? null, startedAt, stage: latest?.stage ?? null, pct: researchPct(latest?.stage ?? null, a.done, a.total), done: a.done, total: a.total };
  }
  if (status === "failed" && newer) return { k: "failed", error: latest?.error ?? null };
  if (status === "cancelled" && newer && !t) return { k: "cancelled" };
  if (status === "done" && newer) {
    const v = latest?.verdict;
    if (v && v.pYes != null) return { k: "thesis", pYes: v.pYes, side: v.side, sizeUsd: v.sizeUsd, edgeC: v.edgeC, at: startedAt };
    const j = latest?.judge?.pYes ?? (!t ? o.agents.find((x) => x.role === "judge")?.probability : null);
    if (j != null) return { k: "judge", pYes: j, at: startedAt };
  }
  if (t) return { k: "thesis", pYes: thesisYes(t), side: t.side, sizeUsd: t.sizeUsd, edgeC: t.edgeC, at: t.createdAt };
  return { k: "none" };
}

/**
 * Edge now, in cents, on `side`: fair value of that side minus what one share costs at the best ask, minus the taker fee.
 * null without a price. `ask` is the side's best ask (0–1).
 */
export function edgeNow(pYes: number, side: Outcome, ask: number | null | undefined, feeRate: number, feeExp = 1): number | null {
  if (ask == null || !(ask > 0 && ask < 1)) return null;
  const fair = side === "YES" ? pYes : 1 - pYes;
  return (fair - ask - takerFeePerShare(feeRate, ask, feeExp)) * 100;
}

/** Below this many cents an edge is not worth trading (fees and slippage eat it). */
export const MIN_EDGE_C = 1;

/**
 * One call per researched market, shown beside the question: `trade` = the thesis was sized and the edge still clears
 * MIN_EDGE_C at the live ask; `gone` = it was sized but the price has since moved; `pass` = researched, nothing worth
 * trading (no sized thesis: the gap was inside fees and our confidence). null while unresearched / running / failed.
 */
export type Verdict = {
  k: "trade" | "gone" | "pass"; side: Outcome | null; edgeC: number | null;
  /** Return on the stake if fair value is right, held to resolution: edge / all-in cost. A 3¢ edge on a 96¢ NO is 3.1%. */
  ret: number | null;
};
export function verdictOf(s: ViewState | null, liveEdgeC: number | null): Verdict | null {
  const pass: Verdict = { k: "pass", side: null, edgeC: null, ret: null };
  if (s?.k === "judge") return pass;
  if (s?.k !== "thesis") return null;
  if (s.sizeUsd < 1) return pass;
  const e = liveEdgeC ?? s.edgeC, cost = (s.side === "YES" ? s.pYes : 1 - s.pYes) - e / 100;
  return { k: e >= MIN_EDGE_C ? "trade" : "gone", side: s.side, edgeC: e, ret: cost > 0 ? e / 100 / cost : null };
}

/** The judge's thesis opens with its call ("Fairly priced: …" / "Mispriced: …"); older theses: the first sentence. */
export function verdictLine(thesis: string | null | undefined): string | null {
  const t = thesis?.trim();
  if (!t) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1]! : t).slice(0, 220);
}

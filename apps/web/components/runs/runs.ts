// Pure helpers behind the run detail view (DESIGN 12.3).
export const STAGES = ["rules", "agents", "judge", "sizing", "done"] as const;
export type NodeState = "done" | "current" | "pending" | "failed" | "cancelled";
export type Node = { label: string; state: NodeState };

export const isLive = (status: string) => status === "running" || status === "queued" || status === "judging";

/** Index of pods.stage in the stepper; unknown / null (not written yet) = the first stage. */
export const stageIndex = (stage: string | null | undefined) => Math.max(0, STAGES.indexOf(stage as (typeof STAGES)[number]));

/** done: all complete. failed/cancelled: stops at pods.stage, that node replaced by the end marker. live: done before, current, pending after. */
export function stepper(stage: string | null | undefined, status: string): Node[] {
  const i = stageIndex(stage);
  if (status === "done") return STAGES.map((label) => ({ label, state: "done" }));
  if (status === "failed" || status === "cancelled") {
    return STAGES.slice(0, i + 1).map((label, j): Node => (j < i ? { label, state: "done" } : status === "failed" ? { label: "✕ failed", state: "failed" } : { label: "⊘ cancelled", state: "cancelled" }));
  }
  return STAGES.map((label, j): Node => ({ label, state: j < i ? "done" : j === i ? "current" : "pending" }));
}

export type BudgetKnobs = { dailySpendCapUsd: number; maxPodsPerDay: number; perPodUsd?: number };
/** settings.budget.perPodUsd when present, else dailySpendCapUsd / maxPodsPerDay. null when neither is usable. */
export function podBudget(b: BudgetKnobs): { usd: number; basis: string } | null {
  if (b.perPodUsd != null && b.perPodUsd > 0) return { usd: b.perPodUsd, basis: "per-pod budget (settings.budget.perPodUsd)" };
  if (b.maxPodsPerDay > 0 && b.dailySpendCapUsd > 0) return { usd: b.dailySpendCapUsd / b.maxPodsPerDay, basis: `per-pod budget = daily cap $${b.dailySpendCapUsd} / ${b.maxPodsPerDay} pods per day` };
  return null;
}
/** spend / budget, unclamped (>= 1 = over). */
export const costRatio = (spend: number, budget: number | null | undefined) => (budget != null && budget > 0 ? spend / budget : 0);

const p2 = (n: number) => String(n).padStart(2, "0");
/** 06:41, or 1:06:41 from an hour up. */
export function clock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ""}${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

type A = { role: string; status: string; output: unknown; startedAt: number | null; finishedAt: number | null; durationS: number | null };
/** Live pods: wall clock. Finished: last agent finish minus start (pods store no finishedAt). */
export function elapsedS(pod: { status: string; startedAt: number }, agents: A[], now: number): number {
  if (isLive(pod.status)) return Math.max(0, (now - pod.startedAt) / 1000);
  const end = Math.max(0, ...agents.map((a) => a.finishedAt ?? 0));
  return end ? Math.max(0, (end - pod.startedAt) / 1000) : 0;
}
/** Running agent: ticks from startedAt; otherwise the stored duration. */
export const agentDurS = (a: A, now: number): number | null => (a.status === "running" && a.startedAt != null ? Math.max(0, (now - a.startedAt) / 1000) : a.durationS);

/** p (or legacy p_hat) from an agent's output JSON. */
export const agentP = (output: unknown): number | null => {
  const o = (output ?? {}) as { probability?: unknown; p_hat?: unknown };
  const v = o.probability ?? o.p_hat;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
/** p_pre: mean of the blind estimates (finished agents other than rules / judge). null when none. */
export function blindMean(agents: A[]): number | null {
  const ps = agents.filter((a) => a.role !== "rules" && a.role !== "judge" && a.status === "ok").map((a) => agentP(a.output)).filter((p): p is number => p != null);
  return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : null;
}

const BUILTIN = ["rules", "source", "base_rate", "news", "red_team"];
const rank = (role: string) => (role === "judge" ? 1000 : BUILTIN.includes(role) ? BUILTIN.indexOf(role) : 100);
/** Built-ins in pipeline order, custom roles after, judge last; stable within a role (id order). */
export const byRole = <T extends { role: string }>(agents: T[]): T[] => agents.map((a, i) => [a, i] as const).sort((x, y) => rank(x[0].role) - rank(y[0].role) || x[1] - y[1]).map(([a]) => a);
/** Index of rows whose role already appeared earlier (a second attempt of the same agent). */
export const retryIds = <T extends { id: number; role: string }>(agents: T[]): Set<number> => {
  const seen = new Set<string>(), out = new Set<number>();
  for (const a of agents) { if (seen.has(a.role)) out.add(a.id); seen.add(a.role); }
  return out;
};

/** True when a scroller is (within `tol` px of) its bottom. */
export const atBottom = (scrollTop: number, clientHeight: number, scrollHeight: number, tol = 8) => scrollHeight - scrollTop - clientHeight <= tol;
/** Tool-call log tail: autoscroll only while the reader was already at the bottom, otherwise count the unseen tail for the "↓ N new" chip. */
export function tailStep(prev: { count: number; unseen: number }, count: number, wasAtBottom: boolean): { count: number; unseen: number; scroll: boolean } {
  if (count < prev.count) return { count, unseen: 0, scroll: wasAtBottom };
  if (wasAtBottom) return { count, unseen: 0, scroll: count > prev.count };
  return { count, unseen: prev.unseen + (count - prev.count), scroll: false };
}

/** $1.42 style. */
export const usd2 = (v: number) => `$${v.toFixed(2)}`;
/** Signed one-decimal dollars: +$18.4 / −$3.0. */
export const usd1s = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(1)}`;

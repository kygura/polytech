export interface BudgetKnobs {
  maxPodsPerDay: number;
  maxConcurrentSandboxes: number;
  dailySpendCapUsd: number;
}
export interface BudgetState {
  podsToday: number;
  activeSandboxes: number;
  spendTodayUsd: number;
}

/** Spend cap is the hard stop and is checked first. `sandboxesNeeded` = sandboxes this pod will open. */
export function canStartPod(s: BudgetState, k: BudgetKnobs, sandboxesNeeded = 1): { ok: boolean; reason?: string } {
  if (s.spendTodayUsd >= k.dailySpendCapUsd) return { ok: false, reason: "DAILY_SPEND_CAP" };
  if (s.podsToday >= k.maxPodsPerDay) return { ok: false, reason: "MAX_PODS_PER_DAY" };
  if (s.activeSandboxes + sandboxesNeeded > k.maxConcurrentSandboxes) return { ok: false, reason: "MAX_CONCURRENT_SANDBOXES" };
  return { ok: true };
}

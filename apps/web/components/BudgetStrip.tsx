import { Kpis } from "./pageParts";

export type Budget = {
  podsToday: number; maxPodsPerDay: number; activeSandboxes: number; maxConcurrentSandboxes: number;
  sandboxS: number; spendTodayUsd: number; dailySpendCapUsd: number; tokensIn: number; tokensOut: number;
};
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function BudgetStrip({ budget: b }: { budget: Budget }) {
  return (
    <Kpis label="budget" items={[
      { label: "pods today", value: `${b.podsToday}/${b.maxPodsPerDay}`, meter: { value: b.podsToday, max: b.maxPodsPerDay } },
      { label: "sandboxes", value: `${b.activeSandboxes}/${b.maxConcurrentSandboxes}`, meter: { value: b.activeSandboxes, max: b.maxConcurrentSandboxes } },
      { label: "sandbox min", value: String(Math.round(b.sandboxS / 60)) },
      { label: "tokens in", value: k(b.tokensIn) },
      { label: "tokens out", value: k(b.tokensOut) },
      { label: "spend today", value: <>${b.spendTodayUsd.toFixed(2)} <span className="muted">/ ${b.dailySpendCapUsd}</span></>, meter: { value: b.spendTodayUsd, max: b.dailySpendCapUsd } },
    ]} />
  );
}

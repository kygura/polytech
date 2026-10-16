import { MeterBar } from "./MeterBar";
import css from "./panels.module.css";

export type Budget = {
  podsToday: number; maxPodsPerDay: number; activeSandboxes: number; maxConcurrentSandboxes: number;
  sandboxS: number; spendTodayUsd: number; dailySpendCapUsd: number; tokensIn: number; tokensOut: number;
};
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function BudgetStrip({ budget: b }: { budget: Budget }) {
  const items: [string, string, number?, number?][] = [
    ["pods today", `${b.podsToday}/${b.maxPodsPerDay}`, b.podsToday, b.maxPodsPerDay],
    ["sandboxes", `${b.activeSandboxes}/${b.maxConcurrentSandboxes}`, b.activeSandboxes, b.maxConcurrentSandboxes],
    ["sandbox min", String(Math.round(b.sandboxS / 60))],
    ["tokens in", k(b.tokensIn)],
    ["out", k(b.tokensOut)],
    ["spend", `$${b.spendTodayUsd.toFixed(2)} / cap $${b.dailySpendCapUsd}`, b.spendTodayUsd, b.dailySpendCapUsd],
  ];
  return (
    <div className={css.strip} aria-label="budget">
      {items.map(([label, v, val, max]) => (
        <span key={label} className={css.stripItem}>
          <span className="muted ui">{label}</span> {v}
          {max != null && <span className={css.meterW}><MeterBar value={val!} max={max} /></span>}
        </span>
      ))}
    </div>
  );
}

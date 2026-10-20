import Link from "next/link";
import { MeterBar } from "../MeterBar";
import { StatusDot } from "../StatusDot";
import { dotStatus } from "../PodTable";
import { hms } from "../fmt";
import { clock, costRatio, isLive, podBudget, stepper, usd2, type BudgetKnobs } from "./runs";
import css from "./runs.module.css";

export function StageStepper({ stage, status }: { stage: string | null; status: string }) {
  const nodes = stepper(stage, status);
  return (
    <ol className={css.stepper} aria-label={`stage: ${nodes[nodes.length - 1]!.label}`} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {nodes.map((n, i) => (
        <li key={i} aria-current={n.state === "current" ? "step" : undefined} title={n.state === "failed" || n.state === "cancelled" ? `${n.state} at ${stage ?? "start"}` : undefined}>
          <span className={css[n.state]}>{n.label}</span>
          {i < nodes.length - 1 && <span className={`${css.join} ${n.state === "done" ? css.done : css.pending}`} aria-hidden>{n.state === "done" ? "━" : "─"}</span>}
        </li>
      ))}
    </ol>
  );
}

export function CostMeter({ costUsd, tools, budget }: { costUsd: number; tools: number; budget: BudgetKnobs }) {
  const b = podBudget(budget);
  const over = costRatio(costUsd, b?.usd) >= 1;
  return (
    <span className={css.cost} title={b?.basis ?? "no per-pod budget configured"}>
      <span className={over ? "neg" : undefined}>{usd2(costUsd)}{b && ` / ${usd2(b.usd)}`}</span>
      {b && <span className={css.bar}><MeterBar value={costUsd} max={b.usd} /></span>}
      <span className="muted">{"Σ"} {tools} tools</span>
    </span>
  );
}

type Props = {
  pod: { id: string; conditionId: string; question: string | null; status: string; stage: string | null; startedAt: number };
  elapsed: number; costUsd: number; tools: number; budget: BudgetKnobs;
  cancelling: boolean; onCancel: () => void;
};

export function RunHeader({ pod, elapsed, costUsd, tools, budget, cancelling, onCancel }: Props) {
  const live = isLive(pod.status);
  return (
    <section className={`pane ${css.head}`} aria-label="run">
      <div className={css.line}>
        <StatusDot status={dotStatus(pod.status)} label={pod.status} />
        <Link href={`/markets/${pod.conditionId}`} className={css.q} title={pod.question ?? pod.conditionId}>{pod.question ?? pod.conditionId}</Link>
        <span className="muted" title={pod.id}>pod {pod.id.slice(0, 8)}</span>
        <span className="muted" suppressHydrationWarning>started {hms(pod.startedAt)}</span>
        <span className="muted" aria-live="off">elapsed {clock(elapsed)}</span>
        <span className={css.grow} />
        {live && <button type="button" className={css.cancel} disabled={cancelling} onClick={onCancel}>{cancelling ? "cancelling…" : "[x] Cancel"}</button>}
      </div>
      <div className={css.line}>
        <StageStepper stage={pod.stage} status={pod.status} />
        <span className={css.grow} />
        <CostMeter costUsd={costUsd} tools={tools} budget={budget} />
      </div>
    </section>
  );
}

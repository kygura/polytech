import Link from "next/link";
import { MeterBar } from "../MeterBar";
import { Button, Panel } from "../ui";
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
      <span className={`n ${over ? "down" : ""}`}>{usd2(costUsd)}{b && ` / ${usd2(b.usd)}`}</span>
      {b && <span className={css.bar}><MeterBar value={costUsd} max={b.usd} /></span>}
      <span className="muted n">{"Σ"} {tools} tools</span>
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
    <>
      <div className="page-h">
        <Link href="/runs" className={css.back}>{"←"} Runs</Link>
        <h1><Link href={`/trade/${encodeURIComponent(pod.conditionId)}`} title={pod.question ?? pod.conditionId}>{pod.question ?? pod.conditionId}</Link></h1>
        {live && <div className="r"><Button variant="danger" disabled={cancelling} onClick={onCancel}>{cancelling ? "cancelling…" : <>Cancel run <kbd>x</kbd></>}</Button></div>}
      </div>
      <Panel title={<StatusDot status={dotStatus(pod.status)} label={pod.status} />} label="run" right={<>
        <span title={pod.id}>pod <span className="n">{pod.id.slice(0, 8)}</span></span>
        <span suppressHydrationWarning>started <span className="n">{hms(pod.startedAt)}</span></span>
        <span aria-live="off">elapsed <span className="n">{clock(elapsed)}</span></span>
      </>}>
        <div className={css.head}>
          <StageStepper stage={pod.stage} status={pod.status} />
          <span className={css.grow} />
          <CostMeter costUsd={costUsd} tools={tools} budget={budget} />
        </div>
      </Panel>
    </>
  );
}

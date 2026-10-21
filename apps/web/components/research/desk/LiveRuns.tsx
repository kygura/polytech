"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { hms } from "../../fmt";
import { Button, EmptyState, ErrorBar, Panel, Progress, Skeleton } from "../../ui";
import { failText, mss, progress, resultText, stageText, triggerText, type Budget, type NotStarted, type QItem, type Run } from "./desk";
import type { Desk } from "./useDesk";
import cx from "./desk.module.css";

const SETTINGS = "Change it in Settings → Research budget.";
const trade = (id: string) => `/trade/${encodeURIComponent(id)}`;

function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** `Running 2 of 5 · Today 12 of 40 runs · Spent $1.20 of $50`, each part with what it limits and where to change it. */
export function BudgetLine({ b }: { b: Budget }) {
  const at = (v: number, max: number) => (v >= max ? "warn" : undefined);
  return (
    <p className={cx.budget} aria-label="research budget">
      <span className={at(b.running, b.maxRunning)} title={`Runs going at the same time. Markets past this wait in the queue. ${SETTINGS}`}>Running <b className="n">{b.running}</b> of <span className="n">{b.maxRunning}</span></span>
      {" · "}
      <span className={at(b.podsToday, b.maxPodsPerDay)} title={`Research runs started today (UTC), all sources. New runs stop at the limit. ${SETTINGS}`}>Today <b className="n">{b.podsToday}</b> of <span className="n">{b.maxPodsPerDay}</span> runs</span>
      {" · "}
      <span className={at(b.spendTodayUsd, b.dailySpendCapUsd)} title={`Model spend today (UTC). New runs stop at the cap. ${SETTINGS}`}>Spent <b className="n">${b.spendTodayUsd.toFixed(2)}</b> of <span className="n">${b.dailySpendCapUsd}</span></span>
    </p>
  );
}

function Head({ question, id, side }: { question: string | null; id: string; side: ReactNode }) {
  return (
    <div className={cx.cardH}>
      <Link href={trade(id)} className={cx.q} title={question ?? id}>{question ?? id}</Link>
      <span className={`${cx.meta} muted`}>{side}</span>
    </div>
  );
}

function RunCard({ r, now, cancelling, onCancel, onRetry }: { r: Run; now: number; cancelling: boolean; onCancel: () => void; onRetry: () => void }) {
  const pct = progress(r);
  const live = r.status === "running";
  const tone = r.status === "done" ? "up" : r.status === "failed" ? "down" : r.status === "cancelled" ? "muted" : "live";
  const text = live ? stageText(r) : r.status === "done" ? resultText(r) : r.status === "failed" ? failText(r.error) : "Cancelled";
  const word = live ? "running" : r.status;
  return (
    <li className={cx.card}>
      <Head question={r.question} id={r.conditionId} side={<>
        <span className={tone === "live" ? cx.live : tone}>{word}</span> · {triggerText(r.trigger)} · <span className="n" title={`started ${hms(r.startedAt)}`}>{live ? mss(now - r.startedAt) : hms(r.startedAt)}</span>
      </>} />
      <Progress value={pct} tone={tone} label={`${r.question ?? r.conditionId}: ${pct}%`} />
      <div className={cx.cardF}>
        <span className={`${cx.text} ${r.status === "failed" ? "down" : r.status === "done" && r.verdict ? "" : "muted"}`} title={r.status === "failed" ? r.error ?? undefined : r.verdict?.thesis ?? r.judge?.thesis ?? undefined}>
          {text}
        </span>
        <span className={cx.acts}>
          {live && <Button size="sm" variant="danger" onClick={onCancel} disabled={cancelling}>{cancelling ? "Cancelling…" : "Cancel"}</Button>}
          {(r.status === "failed" || r.status === "cancelled") && <Button size="sm" onClick={onRetry}>Retry</Button>}
          {r.status === "done" && <Link href={trade(r.conditionId)}>Open market →</Link>}
          <Link href={`/runs/${encodeURIComponent(r.podId)}`}>Details →</Link>
        </span>
      </div>
      {r.status === "failed" && r.error && r.error !== text && <details className={cx.raw}><summary>Error details</summary><code>{r.error}</code></details>}
    </li>
  );
}

function WaitCard({ it, b, starting, onRemove }: { it: QItem; b: Budget | null; starting: boolean; onRemove?: () => void }) {
  return (
    <li className={cx.card}>
      <Head question={it.question} id={it.id} side={<span className={starting ? cx.live : undefined}>{starting ? "starting" : "queued"}</span>} />
      <Progress value={0} label={`${it.question}: ${starting ? "starting" : "queued"}`} />
      <div className={cx.cardF}>
        <span className={`${cx.text} muted`}>{starting ? "Starting…" : b ? `Waiting for a free slot (${b.running} of ${b.maxRunning} running)` : "Waiting for a free slot"}</span>
        {onRemove && <span className={cx.acts}><Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button></span>}
      </div>
    </li>
  );
}

function SkipCard({ it, onRetry, onDismiss }: { it: NotStarted; onRetry: () => void; onDismiss: () => void }) {
  return (
    <li className={cx.card}>
      <Head question={it.question} id={it.id} side={<><span className="warn">not started</span> · <span className="n">{hms(it.at)}</span></>} />
      <div className={cx.cardF}>
        <span className={`${cx.text} warn`}>Not started: {it.reason}</span>
        <span className={cx.acts}><Button size="sm" onClick={onRetry}>Retry</Button><Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></span>
      </div>
    </li>
  );
}

/** Live runs: budget line, then queued / starting / not-started / pod cards, newest first. Shared by the Desk and Automate tabs. */
export function LiveRuns({ desk, empty = "No research runs in the last 24 hours." }: { desk: Desk; empty?: string }) {
  const { live, queue, notStarted, starting, cancelling } = desk;
  const runs = live.data?.runs ?? [];
  const b = live.data?.budget ?? null;
  const now = useNow(runs.some((r) => r.status === "running"));
  const startingOnly = starting.filter((s) => !runs.some((r) => r.conditionId === s.id && r.status === "running"));
  const nRunning = runs.filter((r) => r.status === "running").length;
  const n = queue.length + startingOnly.length + notStarted.length + runs.length;
  return (
    <Panel title="Live runs" label="live runs" className={cx.runs}
      right={<>
        {queue.length > 0 && <span><span className="n">{queue.length}</span> queued</span>}
        {nRunning > 0 && <span className={cx.live}><span className="n">{nRunning}</span> running</span>}
        {live.error && live.data && <span className="warn" title={live.error}>update failed · retrying</span>}
        {live.lastAt != null && <span className="n" title="last update">{hms(live.lastAt)}</span>}
      </>}>
      {b && <BudgetLine b={b} />}
      {queue.length > 0 && <p className={`${cx.note} muted`}>The queue lives in this browser tab: closing it drops queued markets. Runs already started keep going.</p>}
      {live.error && !live.data && <ErrorBar message={`Could not load runs: ${live.error}`} onRetry={live.refresh} />}
      {live.loading && !live.data && <Skeleton rows={4} />}
      {live.data && !n && <EmptyState text={empty} />}
      {n > 0 && (
        <ul className={cx.cards}>
          {startingOnly.map((it) => <WaitCard key={`s-${it.id}`} it={it} b={b} starting />)}
          {queue.map((it) => <WaitCard key={`q-${it.id}`} it={it} b={b} starting={false} onRemove={() => desk.dequeue(it.id)} />)}
          {notStarted.map((it) => <SkipCard key={`n-${it.id}`} it={it} onRetry={() => desk.enqueue([it])} onDismiss={() => desk.dismiss(it.id)} />)}
          {runs.map((r) => <RunCard key={r.podId} r={r} now={now} cancelling={cancelling.includes(r.podId)} onCancel={() => void desk.cancel(r.podId)} onRetry={() => desk.enqueue([{ id: r.conditionId, question: r.question ?? r.conditionId }])} />)}
        </ul>
      )}
    </Panel>
  );
}

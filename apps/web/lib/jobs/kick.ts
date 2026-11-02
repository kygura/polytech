import type { Kv } from "@pm/db";
import type { JobName } from "../api";
import { FULL_PASS_MS, SCOUT_KICK_MS } from "../cadence";

const LOCK_MS = 10 * 60_000;
// own key: the sweep writes kick:sweepAt (public freshness), which must not suppress the snapshot/screen/research steps
const STARTED = "kick:startedAt";
const FULL_AT = "kick:fullAt"; // last kick that asked for the full pass on schedule

type Scope = "watchlist" | "all";
type Step = (name: JobName, scope?: Scope) => Promise<unknown>;
/** The part of the sweep result (sweepUniverse) the chain reads; undefined when the step failed, no counts when it was skipped (lock held). */
type SweepOut = { newMarkets?: number; closed?: number } | undefined;

/**
 * Cron order. Every kick sweeps and refreshes the watchlist books (that snapshot also works paper orders and runs the alert pass).
 * The full pass (every kept market's book, screen, research, then alerts) runs when `full` (the scheduled one is FULL_PASS_MS old) or the sweep
 * changed the universe: it is what spends the function CPU, and most kicks change nothing worth re-screening.
 * Steps keep their durable retries; one that still fails after them must not block the later ones (each job is idempotent and locked).
 */
async function runSteps(step: Step, full: boolean) {
  const run = (n: JobName, sc?: Scope) => step(n, sc).catch((e) => console.error(`chain: ${n} failed`, e));
  const sw = (await run("sweep")) as SweepOut;
  if (!full && !sw?.newMarkets && !sw?.closed) return void (await run("snapshot", "watchlist"));
  await run("snapshot", "all");
  await run("screen");
  await run("research");
  await run("monitor"); // after screen + research: new candidates, structural flags, failed pods, mid moves
}

/** Scouting chain in cron order, same JOBS the cron route runs. Each job keeps its own lock; research keeps its budget cap. */
export async function scoutChain(full = true) {
  "use workflow";
  await runSteps(chainStep, full);
}

/** Same chain without the workflow wrapper (which cannot be called directly outside the workflow runtime): off Vercel, or WORKFLOW_INLINE=1. */
export const runChain = (step: Step = runJob, full = true) => runSteps(step, full);

async function runJob(name: JobName, scope?: Scope) {
  const { JOBS } = await import("../api"); // keep node-only deps out of the workflow bundle
  return name === "snapshot" ? JOBS.snapshot(scope) : JOBS[name]();
}

async function chainStep(name: JobName, scope?: Scope) {
  "use step";
  return runJob(name, scope);
}

/** Like the cron route: Vercel Workflow on Vercel, inline elsewhere (or WORKFLOW_INLINE=1). */
export async function startChain(full = true) {
  if (process.env.VERCEL && process.env.WORKFLOW_INLINE !== "1") {
    const { start } = await import("workflow/api");
    await start(scoutChain, [full]);
  } else await runChain(runJob, full);
}

/**
 * Traffic-triggered scouting: starts the chain when the last kick is older than 30 min and the kick lock is free, asking for the full pass when the
 * last scheduled one is FULL_PASS_MS old. The lock is never released, it expires: at most one start per 10 min even if the start fails. Returns whether it started.
 */
export async function kickIfStale(kv?: Kv, now = Date.now(), run: (full: boolean) => Promise<unknown> = startChain): Promise<boolean> {
  // dynamic: this module is bundled into the workflow bundle, which cannot contain node-only deps (db, auth, agents)
  const { getKv } = await import("@pm/db");
  kv ??= getKv();
  const at = await kv.get<number>(STARTED);
  if (at != null && now - at < SCOUT_KICK_MS) return false;
  if (!(await kv.lock("kick", LOCK_MS))) return false;
  await kv.set(STARTED, now);
  const fullAt = await kv.get<number>(FULL_AT), full = fullAt == null || now - fullAt >= FULL_PASS_MS;
  if (full) await kv.set(FULL_AT, now);
  await run(full);
  return true;
}

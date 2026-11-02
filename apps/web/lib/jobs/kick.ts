import type { Kv } from "@pm/db";
import type { JobName } from "../api";
import { SCOUT_KICK_MS } from "../cadence";

const LOCK_MS = 10 * 60_000;
// own key: the sweep writes kick:sweepAt (public freshness), which must not suppress the kick
const STARTED = "kick:startedAt";

type Step = (name: JobName, scope?: "watchlist") => Promise<unknown>;

/**
 * What a kick runs: sweep (new and closed markets into the universe) and the watchlist books (that snapshot also works paper orders and runs
 * the alert pass). No LLM step: every kept market's book, the screen and research run once a day from the Vercel crons (vercel.json), so new
 * markets a kick sweeps in are screened and researched on the next daily pass. A failed sweep must not block the snapshot (each job is idempotent and locked).
 */
async function runSteps(step: Step) {
  await step("sweep").catch((e) => console.error("chain: sweep failed", e));
  await step("snapshot", "watchlist").catch((e) => console.error("chain: snapshot failed", e));
}

/** Kick chain, same JOBS the cron route runs; each job keeps its own lock. */
export async function scoutChain() {
  "use workflow";
  await runSteps(chainStep);
}

/** Same chain without the workflow wrapper (which cannot be called directly outside the workflow runtime): off Vercel, or WORKFLOW_INLINE=1. */
export const runChain = (step: Step = runJob) => runSteps(step);

async function runJob(name: JobName, scope?: "watchlist") {
  const { JOBS } = await import("../api"); // keep node-only deps out of the workflow bundle
  return name === "snapshot" ? JOBS.snapshot(scope) : JOBS[name]();
}

async function chainStep(name: JobName, scope?: "watchlist") {
  "use step";
  return runJob(name, scope);
}

/** Like the cron route: Vercel Workflow on Vercel, inline elsewhere (or WORKFLOW_INLINE=1). */
export async function startChain() {
  if (process.env.VERCEL && process.env.WORKFLOW_INLINE !== "1") {
    const { start } = await import("workflow/api");
    await start(scoutChain, []);
  } else await runChain(runJob);
}

/**
 * Traffic-triggered scouting: starts the kick chain when the last kick is older than 30 min and the kick lock is free. The lock is never
 * released, it expires: at most one start per 10 min even if the start fails. Returns whether it started.
 */
export async function kickIfStale(kv?: Kv, now = Date.now(), run: () => Promise<unknown> = startChain): Promise<boolean> {
  // dynamic: this module is bundled into the workflow bundle, which cannot contain node-only deps (db, auth, agents)
  const { getKv } = await import("@pm/db");
  kv ??= getKv();
  const at = await kv.get<number>(STARTED);
  if (at != null && now - at < SCOUT_KICK_MS) return false;
  if (!(await kv.lock("kick", LOCK_MS))) return false;
  await kv.set(STARTED, now);
  await run();
  return true;
}

import type { Kv } from "@pm/db";
import type { JobName } from "../api";
import { SCOUT_KICK_MS } from "../cadence";

const LOCK_MS = 10 * 60_000;
// own key: the sweep writes kick:sweepAt (public freshness), which must not suppress the kick
const STARTED = "kick:startedAt";

type Step = (name: JobName, scope?: "watchlist") => Promise<unknown>;

/**
 * What a kick runs: the watchlist books only (that snapshot also works paper orders and runs the alert pass). The sweep walks ~26k Gamma
 * markets and was most of the CPU a kick burned (Vercel Hobby caps Fluid Active CPU at 4 h/month), so it runs only from the 01:00 cron
 * with every kept market's book, the screen and research (vercel.json).
 */
async function runSteps(step: Step) {
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
 * Traffic-triggered scouting: starts the kick chain when the last kick is older than SCOUT_KICK_MS (1 h) and the kick lock is free. The lock is never
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

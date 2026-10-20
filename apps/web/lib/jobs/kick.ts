import type { Kv } from "@pm/db";
import type { JobName } from "../api";

const STALE_MS = 30 * 60_000;
const LOCK_MS = 10 * 60_000;
// own key: the sweep writes kick:sweepAt (public freshness), which must not suppress the snapshot/screen/research steps
const STARTED = "kick:startedAt";

/** Scouting chain in cron order, same JOBS the cron route runs. Each job keeps its own lock; research keeps its budget cap. */
export async function scoutChain() {
  "use workflow";
  // steps keep their durable retries; one that still fails after them must not block the later ones (each job is idempotent and locked)
  const run = (n: JobName, sc?: "watchlist" | "all") => chainStep(n, sc).catch((e) => console.error(`chain: ${n} failed`, e));
  await run("sweep");
  await run("snapshot", "all");
  await run("screen");
  await run("research");
  await run("monitor"); // after screen + research: new candidates, structural flags, failed pods, mid moves
}

async function chainStep(name: JobName, scope?: "watchlist" | "all") {
  "use step";
  const { JOBS } = await import("../api"); // keep node-only deps out of the workflow bundle
  return name === "snapshot" ? JOBS.snapshot(scope) : JOBS[name]();
}

/** Like the cron route: Vercel Workflow on Vercel, inline elsewhere (or WORKFLOW_INLINE=1). */
async function startChain() {
  if (process.env.VERCEL && process.env.WORKFLOW_INLINE !== "1") {
    const { start } = await import("workflow/api");
    await start(scoutChain, []);
  } else await scoutChain();
}

/**
 * Traffic-triggered scouting: starts the chain when the last kick is older than 30 min and the kick lock is free.
 * The lock is never released, it expires: at most one start per 10 min even if the start fails. Returns whether it started.
 */
export async function kickIfStale(kv?: Kv, now = Date.now(), run: () => Promise<unknown> = startChain): Promise<boolean> {
  // dynamic: this module is bundled into the workflow bundle, which cannot contain node-only deps (db, auth, agents)
  const { getKv } = await import("@pm/db");
  kv ??= getKv();
  const at = await kv.get<number>(STARTED);
  if (at != null && now - at < STALE_MS) return false;
  if (!(await kv.lock("kick", LOCK_MS))) return false;
  await kv.set(STARTED, now);
  await run();
  return true;
}

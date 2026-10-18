import { getKv, type Kv } from "@pm/db";
import { JOBS, type JobName } from "../api";
import { KICK_AT as AT } from "../public";

const STALE_MS = 30 * 60_000;
const LOCK_MS = 10 * 60_000;

/** Scouting chain in cron order, same JOBS the cron route runs. Each job keeps its own lock; research keeps its budget cap. */
export async function scoutChain() {
  "use workflow";
  await chainStep("sweep");
  await chainStep("snapshot", "all");
  await chainStep("screen");
  await chainStep("research");
}

async function chainStep(name: JobName, scope?: "watchlist" | "all") {
  "use step";
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
export async function kickIfStale(kv: Kv = getKv(), now = Date.now(), run: () => Promise<unknown> = startChain): Promise<boolean> {
  const at = await kv.get<number>(AT);
  if (at != null && now - at < STALE_MS) return false;
  if (!(await kv.lock("kick", LOCK_MS))) return false;
  await kv.set(AT, now);
  await run();
  return true;
}

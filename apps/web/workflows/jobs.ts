import { JOBS, type JobName } from "../lib/api";

// Durable wrapper: Vercel Workflow survives redeploys; the step is a one-liner into lib/jobs.
export async function cronWorkflow(name: JobName, scope?: "watchlist" | "all") {
  "use workflow";
  return await runStep(name, scope);
}

async function runStep(name: JobName, scope?: "watchlist" | "all") {
  "use step";
  return name === "snapshot" ? JOBS.snapshot(scope) : JOBS[name]();
}

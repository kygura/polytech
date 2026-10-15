import { checkCron } from "../../../../lib/auth";
import { JOBS, json, notFound, type JobName } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Long jobs go to Vercel Workflow on Vercel; everywhere else (or WORKFLOW_INLINE=1) they run inline.
async function handle(req: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!checkCron(req.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);
  const name = (await params).job;
  if (!Object.hasOwn(JOBS, name)) return notFound();
  const job = name as JobName;
  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "watchlist";

  const long = job === "research" || (job === "snapshot" && scope === "all");
  if (long && process.env.VERCEL && process.env.WORKFLOW_INLINE !== "1") {
    const [{ start }, { cronWorkflow }] = await Promise.all([import("workflow/api"), import("../../../../workflows/jobs")]);
    const run = await start(cronWorkflow, [job, scope]);
    return json({ started: true, runId: run.runId });
  }
  const out = (await (job === "snapshot" ? JOBS.snapshot(scope) : JOBS[job]())) as { skipped?: boolean; reason?: string };
  return out?.skipped ? json({ skipped: true, reason: out.reason }) : json({ started: true, runId: crypto.randomUUID() });
}
export { handle as GET, handle as POST };

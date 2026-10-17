import { calibrateNightly, deps, expireProposals, getSettings, paperBook, propose, read, reconcileJob, researchShortlist, screenAll, snapshotBooks, sweepUniverse, syncFills, type Decision, type Deps } from "./jobs";
import type { z } from "zod";

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const notFound = () => json({ error: "not found" }, 404);

/** zod parse -> `{data}` or a ready 400 `{res}` with the issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): { data: z.infer<S>; res?: undefined } | { data?: undefined; res: Response } {
  const r = schema.safeParse(input);
  return r.success ? { data: r.data } : { res: json({ error: "invalid", issues: r.error.issues }, 400) };
}
export const parseBody = async <S extends z.ZodType>(req: Request, schema: S) => parse(schema, await req.json().catch(() => undefined));

// one wiring per process; settings re-read per call so PUT /api/settings reaches the jobs
/** Memoise a promise but drop it on reject, so one failed init is retried instead of 500-ing until restart. */
const once = <T>(init: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= init().catch((e) => ((p = undefined), Promise.reject(e))));
};
const base = once(() => deps());
export const getDeps = async (): Promise<Deps> => {
  const b = await base();
  return { ...b, settings: await getSettings(b.db) };
};
export const getRead = once(() => read.readDeps());

// ---- cron jobs (shared by the cron route and the workflow step) ----
export const JOBS = {
  sweep: () => getDeps().then(sweepUniverse),
  snapshot: (scope: "watchlist" | "all" = "watchlist") => getDeps().then((d) => snapshotBooks(d, scope)),
  screen: () => getDeps().then(screenAll),
  research: () => getDeps().then((d) => researchShortlist(d)),
  paper: () => getDeps().then(paperBook),
  calibrate: () => getDeps().then(calibrateNightly),
  propose: () => getDeps().then(propose),
  expire: () => getDeps().then(expireProposals),
  sync: () => getDeps().then(syncFills),
  reconcile: () => getDeps().then(reconcileJob),
};
export type JobName = keyof typeof JOBS;

/** Proposal decision -> HTTP. Refusals are 409 with the reason; the push route maps everything non-ok to one generic body itself. */
export const decisionResponse = (r: Decision) => (r.ok ? json(r) : json({ error: r.error }, r.error === "NOT_FOUND" ? 404 : 409));

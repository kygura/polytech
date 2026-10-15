import { calibrateNightly, deps, getSettings, paperBook, read, researchShortlist, screenAll, snapshotBooks, sweepUniverse, type Deps } from "./jobs";
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
let base: Promise<Deps> | undefined;
export const getDeps = async (): Promise<Deps> => {
  const b = await (base ??= deps());
  return { ...b, settings: await getSettings(b.db) };
};
let rd: Promise<read.ReadDeps> | undefined;
export const getRead = () => (rd ??= read.readDeps());

// ---- cron jobs (shared by the cron route and the workflow step) ----
export const JOBS = {
  sweep: () => getDeps().then(sweepUniverse),
  snapshot: (scope: "watchlist" | "all" = "watchlist") => getDeps().then((d) => snapshotBooks(d, scope)),
  screen: () => getDeps().then(screenAll),
  research: () => getDeps().then((d) => researchShortlist(d)),
  paper: () => getDeps().then(paperBook),
  calibrate: () => getDeps().then(calibrateNightly),
};
export type JobName = keyof typeof JOBS;

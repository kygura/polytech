import type { Db } from "./client";
import type { snapshots } from "./schema";
import type { Handle } from "./store/db";

/** snapshots and screens share the `cond` index shape; one handle type for the helpers below. */
const hist = (db: Db, t: "snapshots" | "screens") => db[t] as unknown as Handle<typeof snapshots>;

const DAY = 86_400_000;
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export const latestSnapshot = async (db: Db, conditionId: string) =>
  (await db.snapshots.first("cond", { conditionId }, { order: "desc" })) ?? undefined;

export const insertSnapshots = (db: Db, rows: (typeof snapshots.$inferInsert)[]) => db.snapshots.insertMany(rows);

/** Newest row id per market (by the per-market ts index). */
const newestIds = async (db: Db, t: "snapshots" | "screens", conds: string[]) =>
  new Set((await hist(db, t).idsEach("cond", conds.map((conditionId) => ({ conditionId })), { order: "desc", limit: 1 })).flat());

/** Keep the newest row per market; keep rows newer than `days` only for `watched` markets; delete the rest. Returns the number deleted. */
export const pruneSnapshots = async (db: Db, watched: string[], now = Date.now(), days = 7) => {
  const keepRecent = new Set(watched), cutoff = now - days * DAY;
  const conds = (await db.snapshots.distinct("cond")).filter((c): c is string => c !== null);
  let n = 0;
  for (const part of chunks(conds, 200)) {
    // watched: rows older than the cutoff go; unwatched (or nothing watched): every row but the newest goes
    const ids = await db.snapshots.idsEach("cond", part.map((conditionId) => ({ conditionId })), { order: "desc", offset: 1 });
    const recent = await db.snapshots.idsEach("cond", part.map((conditionId) => ({ conditionId })), { min: cutoff });
    for (let i = 0; i < part.length; i++) {
      const keep = keepRecent.size && keepRecent.has(part[i]!) ? new Set(recent[i]) : new Set<string>();
      const doomed = ids[i]!.filter((id) => !keep.has(id));
      if (doomed.length) n += await db.snapshots.purge(doomed, { conditionId: part[i]! }); // no row download (book JSON)
    }
  }
  return n;
};

/** Screen runs are only read at the latest run, the last hour (sets) and the newest row per market: keep those and `days` of runs, delete the rest. */
export const pruneScreens = async (db: Db, now = Date.now(), days = 2) => {
  const cutoff = now - days * DAY;
  let n = 0;
  for (const part of chunks(await db.screens.ids("byTs", {}, { lt: cutoff }), 500)) {
    const rows = await db.screens.getMany(part.map(Number));
    const keep = await newestIds(db, "screens", [...new Set(rows.map((r) => r.conditionId))]);
    n += (await db.screens.deleteMany(rows.filter((r) => !keep.has(String(r.id))).map((r) => r.id))).length;
  }
  // run pointers older than the window, except the newest run
  const latest = await db.screenRuns.first("byTs", {}, { order: "desc" });
  const old = (await db.screenRuns.find("byTs", {}, { lt: cutoff })).filter((r) => r.ts.getTime() !== latest?.ts.getTime());
  if (old.length) await db.screenRuns.deleteMany(old.map((r) => r.ts.getTime()));
  return n;
};

/** Every market the user's own data names (research, theses, orders, positions, proposals, sets, flags, journal, alerts): never pruned. */
export const referencedMarkets = async (db: Db): Promise<Set<string>> => {
  const lists = await Promise.all([
    db.theses.distinct("cond"), db.positions.distinct("cond"), db.proposals.distinct("cond"), db.pods.distinct("cond"),
    db.paperOrders.distinct("cond"), db.orders.distinct("cond"), db.journal.distinct("cond"), db.alerts.distinct("cond"),
    db.marketFlags.pks(), db.outcomes.pks(), db.triage.pks(),
    db.proposalSets.all().then((r) => r.flatMap((x) => x.legs.map((l) => l.conditionId))),
  ]);
  return new Set(lists.flat().filter((c): c is string => c !== null));
};

/** Delete every market outside `keep`, then the latest/history/screen rows of markets no longer stored. An empty `keep` deletes nothing. */
export const pruneMarkets = async (db: Db, keep: string[]) => {
  if (!keep.length) return;
  const k = new Set(keep);
  const gone = (await db.markets.pks()).filter((c) => !k.has(c));
  for (const c of chunks(gone, 500)) await db.markets.deleteMany(c);
  const stored = new Set(await db.markets.pks());
  const orphanLatest = (await db.marketLatest.pks()).filter((c) => !stored.has(c));
  for (const c of chunks(orphanLatest, 500)) await db.marketLatest.deleteMany(c);
  for (const t of ["snapshots", "screens"] as const) {
    const orphans = (await hist(db, t).distinct("cond")).filter((c): c is string => c !== null && !stored.has(c));
    for (const part of chunks(orphans, 200)) {
      const ids = await hist(db, t).idsEach("cond", part.map((conditionId) => ({ conditionId })));
      for (let i = 0; i < part.length; i++) {
        if (!ids[i]!.length) continue;
        // snapshots: purge (no book JSON download); screens' run index needs each row's ts, so read those (small) rows
        if (t === "snapshots") await db.snapshots.purge(ids[i]!, { conditionId: part[i]! });
        else for (const c of chunks(ids[i]!, 500)) await db.screens.deleteMany(c.map(Number));
      }
    }
  }
};

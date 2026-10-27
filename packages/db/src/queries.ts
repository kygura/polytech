import { and, desc, eq, isNotNull, lt, notExists, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { alerts, journal, marketFlags, marketLatest, markets, orders, outcomes, paperOrders, pods, positions, proposalSets, proposals, screens, snapshots, theses, triage } from "./schema";

export const latestSnapshot = async (db: Db, conditionId: string) =>
  (await db.select().from(snapshots).where(eq(snapshots.conditionId, conditionId)).orderBy(desc(snapshots.ts)).limit(1))[0];

export const insertSnapshots = (db: Db, rows: (typeof snapshots.$inferInsert)[]) => db.insert(snapshots).values(rows);

/** Keep the newest row per market; keep rows newer than `days` only for `watched` markets; delete the rest. */
export const pruneSnapshots = (db: Db, watched: string[], now = Date.now(), days = 7) => {
  const old = lt(snapshots.ts, new Date(now - days * 86_400_000));
  return db.delete(snapshots).where(and(
    sql`exists (select 1 from ${snapshots} n where n.condition_id = ${snapshots.conditionId} and n.ts > ${snapshots.ts})`,
    watched.length ? or(old, notInArray(snapshots.conditionId, watched)) : undefined,
  ));
};

/** Screen runs are only read at the latest run, the last hour (sets) and the newest row per market: keep those and `days` of runs, delete the rest. */
export const pruneScreens = (db: Db, now = Date.now(), days = 2) =>
  db.delete(screens).where(and(
    lt(screens.ts, new Date(now - days * 86_400_000)),
    sql`exists (select 1 from ${screens} n where n.condition_id = ${screens.conditionId} and n.ts > ${screens.ts})`,
  ));

/** Every market the user's own data names (research, theses, orders, positions, proposals, sets, flags, journal, alerts): never pruned. */
export const referencedMarkets = async (db: Db): Promise<Set<string>> => {
  const ids = (t: typeof theses | typeof positions | typeof proposals | typeof pods | typeof paperOrders | typeof orders | typeof journal | typeof marketFlags | typeof outcomes | typeof triage) =>
    db.selectDistinct({ c: t.conditionId }).from(t).then((r) => r.map((x) => x.c));
  const lists = await Promise.all([
    ...[theses, positions, proposals, pods, paperOrders, orders, journal, marketFlags, outcomes, triage].map(ids),
    db.selectDistinct({ c: alerts.conditionId }).from(alerts).where(isNotNull(alerts.conditionId)).then((r) => r.map((x) => x.c!)),
    db.select({ l: proposalSets.legs }).from(proposalSets).then((r) => r.flatMap((x) => x.l.map((l) => l.conditionId))),
  ]);
  return new Set(lists.flat());
};

/** Delete every market outside `keep`, then the latest/history/screen rows of markets no longer stored. An empty `keep` deletes nothing. */
export const pruneMarkets = async (db: Db, keep: string[]) => {
  if (!keep.length) return;
  await db.delete(markets).where(notInArray(markets.conditionId, keep));
  const orphan = (c: typeof marketLatest.conditionId | typeof snapshots.conditionId | typeof screens.conditionId) =>
    notExists(db.select({ x: sql`1` }).from(markets).where(eq(markets.conditionId, c)));
  await db.delete(marketLatest).where(orphan(marketLatest.conditionId));
  await db.delete(snapshots).where(orphan(snapshots.conditionId));
  await db.delete(screens).where(orphan(screens.conditionId));
};

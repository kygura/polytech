import { and, desc, eq, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { snapshots } from "./schema";

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

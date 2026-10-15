import { desc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { snapshots } from "./schema";

export const latestSnapshot = async (db: Db, conditionId: string) =>
  (await db.select().from(snapshots).where(eq(snapshots.conditionId, conditionId)).orderBy(desc(snapshots.ts)).limit(1))[0];

export const insertSnapshots = (db: Db, rows: (typeof snapshots.$inferInsert)[]) => db.insert(snapshots).values(rows);

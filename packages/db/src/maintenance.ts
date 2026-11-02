import type { Db } from "./client";
import { tables } from "./schema";
import { emptyBatch } from "./store/backend";
import { decode, indexEntries, uniqueEntries, type TableDef } from "./store/table";

export type ReindexReport = { table: string; rows: number; uniqueConflicts: string[] }[];

/**
 * Add every stored row to the indexes and unique constraints declared in schema.ts (after adding an index, or after copying raw
 * rows in). Additive and idempotent: entries already present are rewritten with the same score; nothing is removed, so it is
 * safe while the app runs. A unique value already owned by another row is reported, not taken.
 */
export async function reindex(db: Db, only?: string[]): Promise<ReindexReport> {
  const b = db.backend, out: ReindexReport = [];
  for (const [key, t] of Object.entries(tables) as [string, TableDef][]) {
    if (only?.length && !only.includes(key) && !only.includes(t.name)) continue;
    const rows = await b.scan(t.name);
    const conflicts: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const batch = emptyBatch();
      const per = part.map((s) => {
        const r = decode(t, s.json);
        const one = emptyBatch();
        for (const [k, sc] of indexEntries(t, r)) one.zadd.push({ k, s: sc, m: s.pk });
        for (const [k, v] of uniqueEntries(t, r)) one.claim.push({ k, v, pk: s.pk });
        batch.zadd.push(...one.zadd);
        batch.claim.push(...one.claim);
        return { pk: s.pk, one };
      });
      if ((await b.commit(batch)).ok) continue;
      for (const p of per) { // a unique value is taken: find which rows, keep their index entries
        if ((await b.commit(p.one)).ok) continue;
        conflicts.push(p.pk);
        await b.commit({ ...p.one, claim: [] });
      }
    }
    out.push({ table: key, rows: rows.length, uniqueConflicts: conflicts });
  }
  return out;
}

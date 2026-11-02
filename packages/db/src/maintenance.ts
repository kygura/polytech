import type { Db } from "./client";
import { tables } from "./schema";
import { emptyBatch, type Batch, type Stored } from "./store/backend";
import { decode, indexEntries, uniqueEntries, type TableDef } from "./store/table";

export type ReindexReport = { table: string; rows: number; uniqueConflicts: string[] }[];

/** Index entries and unique claims for one stored row, checked against the version it was read at. */
const rowBatch = (t: TableDef, s: Stored): Batch => {
  const r = decode(t, s.json), b = emptyBatch();
  b.expect.push({ t: t.name, pk: s.pk, ver: s.ver });
  for (const [k, sc] of indexEntries(t, r)) b.zadd.push({ k, s: sc, m: s.pk });
  for (const [k, v] of uniqueEntries(t, r)) b.claim.push({ k, v, pk: s.pk });
  return b;
};
const merge = (bs: Batch[]): Batch => {
  const out = emptyBatch();
  for (const b of bs) { out.expect.push(...b.expect); out.zadd.push(...b.zadd); out.claim.push(...b.claim); }
  return out;
};

/**
 * Add every stored row to the indexes and unique constraints declared in schema.ts (after adding an index, or after copying raw
 * rows in). Additive and idempotent: entries already present are rewritten with the same score; nothing is removed. Each row's
 * entries commit only if the row is still at the version scanned (a row changed meanwhile is re-read; its own write already
 * indexed it), so it is safe while the app runs. A unique value already owned by another row is reported, not taken.
 */
export async function reindex(db: Db, only?: string[]): Promise<ReindexReport> {
  const b = db.backend, out: ReindexReport = [];
  for (const [key, t] of Object.entries(tables) as [string, TableDef][]) {
    if (only?.length && !only.includes(key) && !only.includes(t.name)) continue;
    const rows = await b.scan(t.name);
    const conflicts: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      let part = rows.slice(i, i + 200);
      for (let attempt = 0; part.length; attempt++) {
        if ((await b.commit(merge(part.map((s) => rowBatch(t, s))))).ok) break;
        // one row at a time: find the changed rows (re-read them) and the unique conflicts (report them, index the rest)
        const retry: Stored[] = [];
        for (const s of part) {
          const one = rowBatch(t, s);
          const res = await b.commit(one);
          if (res.ok) continue;
          if (res.reason === "unique") {
            conflicts.push(s.pk);
            const noClaim = await b.commit({ ...one, claim: [] });
            if (noClaim.ok) continue;
          }
          const [fresh] = await b.get(t.name, [s.pk]);
          if (fresh) retry.push(fresh); // deleted meanwhile: nothing to index
        }
        if (attempt >= 5) throw new Error(`reindex ${key}: rows keep changing (${retry.map((s) => s.pk).join(", ")})`);
        part = retry;
      }
    }
    out.push({ table: key, rows: rows.length, uniqueConflicts: [...new Set(conflicts)] });
  }
  return out;
}

import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, SQLiteTable, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../src/client";
import * as schema from "../src/schema";

// Row conversion for the one-off copy off Postgres (Supabase) into libSQL: rows as postgres-js returns them -> drizzle insert values.

/** Every schema table, referenced tables first (proposal_sets before orders before proposals), so inserts pass the FK checks. */
export function tablesInFkOrder(): SQLiteTable[] {
  const out: SQLiteTable[] = [];
  const seen = new Set<SQLiteTable>();
  const visit = (t: SQLiteTable) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const fk of getTableConfig(t).foreignKeys) visit(fk.reference().foreignTable);
    out.push(t);
  };
  for (const t of Object.values(schema) as unknown[]) if (is(t, SQLiteTable)) visit(t);
  return out;
}

/** Rows per multi-row INSERT: one bound parameter per column per row, kept well under SQLite's 32766 limit. */
export const rowsPerChunk = (t: SQLiteTable): number => Math.max(1, Math.min(500, Math.floor(30_000 / Object.keys(getTableColumns(t)).length)));

export type Converted = {
  rows: Record<string, unknown>[];
  dropped: string[]; // Postgres columns the schema no longer has (left behind)
  missing: string[]; // schema columns Postgres lacks (column default, else null)
  nonFinite: string[]; // columns where NaN/±Infinity became null (libSQL binds only finite numbers; SQLite has no NaN)
};

/** Postgres rows (snake_case keys, postgres-js types) -> insert values keyed like the drizzle table. Throws on a value the column can't hold. */
export function convertRows(table: SQLiteTable, pgRows: readonly Record<string, unknown>[]): Converted {
  const name = getTableConfig(table).name;
  const cols = new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col.name, { key, col }]));
  const dropped = new Set<string>(), missing = new Set<string>(), nonFinite = new Set<string>();
  const rows = pgRows.map((pg) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pg)) {
      const c = cols.get(k);
      if (!c) { dropped.add(k); continue; }
      let x = value(`${name}.${k}`, c.col, v);
      if (typeof x === "number" && !Number.isFinite(x)) { nonFinite.add(k); x = null; }
      out[c.key] = x;
    }
    for (const k of cols.keys()) if (!(k in pg)) missing.add(k);
    return out;
  });
  return { rows, dropped: [...dropped].sort(), missing: [...missing].sort(), nonFinite: [...nonFinite].sort() };
}

function value(where: string, col: SQLiteColumn, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const bad = () => new Error(`${where}: can't store ${typeof v} ${JSON.stringify(String(v).slice(0, 40))} in a ${col.columnType} column`);
  switch (col.dataType) {
    case "json": // postgres-js parses json/jsonb; drizzle stringifies on insert
      return v;
    case "date": { // timestamptz arrives as a Date; drizzle stores epoch ms
      const d = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : undefined;
      if (!d || Number.isNaN(d.getTime())) throw bad();
      return d;
    }
    case "boolean":
      if (typeof v === "boolean") return v;
      throw bad();
    case "number": { // int8 (bigserial ids) and numeric arrive as strings
      const n = typeof v === "number" ? v : typeof v === "string" || typeof v === "bigint" ? Number(v) : NaN;
      if (Number.isNaN(n) && typeof v !== "number") throw bad();
      if (col.columnType === "SQLiteInteger" && Number.isFinite(n) && !Number.isSafeInteger(n)) throw bad();
      return n;
    }
    case "string":
      if (typeof v === "string") return v; // text, uuid
      if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, ""); // date (spend.day): postgres-js parses it as UTC midnight
      throw bad();
  }
  throw bad();
}

/** Insert in rowsPerChunk chunks; rows whose key (or a unique column) already exists are skipped, so a rerun is idempotent. Returns rows inserted. */
export async function insertRows(db: Db, table: SQLiteTable, rows: readonly Record<string, unknown>[]): Promise<number> {
  const n = rowsPerChunk(table);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += n) inserted += (await db.insert(table).values(rows.slice(i, i + n)).onConflictDoNothing()).rowsAffected;
  return inserted;
}

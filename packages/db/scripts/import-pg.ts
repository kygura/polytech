/**
 * One-time copy of the old Postgres database (Supabase, built from the Drizzle schema this package used to ship) into the
 * configured store (UPSTASH_REDIS_REST_URL/TOKEN or REDIS_URL; see README).
 *
 *   PG_URL=postgres://... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... bun run db:import-pg [--dry-run] [--overwrite]
 *
 * Reads every table, converts rows (snake_case -> camelCase, bigint -> number, date -> "YYYY-MM-DD"), writes them through the
 * store (so indexes and unique constraints are built), moves each serial sequence past the highest imported id, rebuilds the
 * screen-run pointers (screen_runs) from screens, copies live `kv` rows (not locks) into the kv store, then compares row counts. Re-running it upserts the same rows again.
 *
 * Refuses to write into a store that already holds markets or settings unless --overwrite: imported rows replace rows with the
 * same key, which after cutover would put back stale data.
 * Postgres is only read. Use the session pooler or a direct connection (port 5432); the transaction pooler (6543) works too.
 */
import postgres from "postgres";
import { closeDb, getDb } from "../src/client";
import { getKv } from "../src/kv";
import { tables } from "../src/schema";
import type { Handle } from "../src/store/db";
import type { TableDef } from "../src/store/table";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run"), overwrite = args.has("--overwrite");
const url = process.env.PG_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("set PG_URL (the old Postgres connection string)");

const pg = postgres(url, { prepare: false, max: 2, connect_timeout: 15, transform: postgres.camel });
const db = getDb();
if (db.backend.kind === "memory" && !process.env.STORE_FILE) console.warn("warning: no Redis configured; importing into the local file store");

const exists = async (name: string) =>
  (await pg`select to_regclass(${"public." + name}) is not null as ok`)[0]!.ok as boolean;

function convert(t: TableDef, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(t.cols)) {
    let v = row[k];
    if (v === undefined || v === null) { out[k] = v === null ? null : undefined; continue; }
    if ((c.cfg.kind === "int" || c.cfg.kind === "num") && typeof v !== "number") v = Number(v);
    else if (c.cfg.kind === "day" && v instanceof Date) v = v.toISOString().slice(0, 10);
    else if (c.cfg.kind === "date" && !(v instanceof Date)) v = new Date(v as string);
    out[k] = v;
  }
  return out;
}

try {
  if (!dry && !overwrite) {
    const busy = (await db.markets.pks()).length || (await db.settings.pks()).length;
    if (busy) throw new Error("the store already holds markets/settings: pass --overwrite to import over it");
  }
  const report: string[] = [];
  for (const [key, t] of Object.entries(tables) as [string, TableDef][]) {
    if (key === "screenRuns") continue; // rebuilt from screens below
    if (!(await exists(t.name))) { report.push(`${key}: no table ${t.name} in Postgres, skipped`); continue; }
    const pgCount = Number((await pg`select count(*)::bigint as n from ${pg(t.name)}`)[0]!.n);
    if (dry) { report.push(`${key}: ${pgCount} rows (dry run)`); continue; }
    const h = (db as unknown as Record<string, Handle<TableDef>>)[key]!;
    let n = 0, maxId = 0;
    const order = t.pk.map((c) => c.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()));
    const cursor = pg`select * from ${pg(t.name)} order by ${pg(order)}`.cursor(500);
    for await (const rows of cursor) {
      const conv = rows.map((r) => convert(t, r as Record<string, unknown>));
      if (t.serial) for (const r of conv) maxId = Math.max(maxId, Number(r[t.serial]));
      await h.upsertMany(conv as never); // existing rows (re-run) take the imported values
      n += conv.length;
    }
    if (t.serial && maxId) await db.backend.seqAtLeast(t.name, maxId);
    const stored = (await h.pks()).length;
    report.push(`${key}: postgres ${pgCount}, imported ${n}, store now ${stored}${stored < pgCount ? "  <-- MISSING ROWS" : ""}`);
  }
  if (!dry && (await exists("screens"))) {
    // Postgres had no run table: a run was every screens row sharing one ts, the latest run = max(ts). Rebuild the pointers.
    const runs = (await pg`select ts, count(*)::int as n from screens group by ts`).map((r) => ({ ts: r.ts as Date, rows: Number(r.n) }));
    await db.screenRuns.upsertMany(runs);
    report.push(`screenRuns: ${runs.length} runs rebuilt from screens`);
  }
  if (!dry && (await exists("kv"))) {
    const kv = getKv();
    let n = 0;
    for (const r of await pg`select key, value, expires_at from kv where key not like 'lock:%' and key not like 'rl:%' and (expires_at is null or expires_at > now())`) {
      const ttl = r.expiresAt ? (r.expiresAt as Date).getTime() - Date.now() : undefined;
      await kv.set(r.key as string, r.value, ttl);
      n++;
    }
    report.push(`kv: ${n} live values copied`);
  }
  console.log(report.join("\n"));
} catch (e) {
  console.error(`import failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
  await closeDb();
  process.exit(process.exitCode ?? 0); // the kv client (getKv) holds its own connection open
}

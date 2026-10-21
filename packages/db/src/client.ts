import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../drizzle");

// Process-wide, not module-level: `next dev` gives RSC pages and route handlers separate module instances, and a second PGlite on the same dir
// reads/writes a different in-memory copy and aborts on migrate. globalThis is shared by all of them (same pattern as the event bus).
type Conn = { db?: Db; migrator?: () => Promise<void>; closer?: () => Promise<void> };
const conn: Conn = ((globalThis as { __pmDb?: Conn }).__pmDb ??= {});

/**
 * DATABASE_URL → any Postgres over TCP via postgres-js (Supabase pooler, Neon, self-hosted); else PGlite at <repo>/.data/pglite (PGLITE_DIR overrides, `memory://` for tests).
 * prepare:false keeps it safe behind transaction-mode poolers (Supavisor :6543, PgBouncer); small pool + idle timeout suit serverless instances.
 */
export function getDb(): Db {
  if (conn.db) return conn.db;
  const url = process.env.DATABASE_URL;
  if (url) {
    const opts = { prepare: false, idle_timeout: 20, connect_timeout: 10 } as const;
    // postgres-js pipelines extra queries onto busy connections; behind Supavisor's transaction mode the replies can come back crossed
    // (a one-row max(ts) result once landed in a theses select and broke /watchlist). max_pipeline 0 keeps one query per connection.
    // That also stops sql.begin from reserving its connection (UNSAFE_TRANSACTION), so transactions run on a small client of their own.
    const sql = postgres(url, { ...opts, max: 5, max_pipeline: 0 } as postgres.Options<{}>); // max_pipeline is read at runtime but missing from the typings
    const txSql = postgres(url, { ...opts, max: 2 });
    drizzlePg({ client: txSql }); // only for its parser/serializer setup on txSql.options
    sql.begin = txSql.begin;
    const d = drizzlePg({ client: sql, schema });
    // drizzle makes date/time serializers pass-through (it maps column values itself), but raw sql`${new Date()}` params skip that mapping
    // and postgres-js then rejects the Date. neon-http and PGlite accept Dates, so restore that for timestamp/timestamptz/date.
    for (const c of [sql, txSql])
      for (const oid of [1114, 1184, 1082]) {
        const next = c.options.serializers[oid];
        c.options.serializers[oid] = (v: unknown) => (v instanceof Date ? (oid === 1082 ? v.toISOString().slice(0, 10) : v.toISOString()) : next!(v));
      }
    conn.migrator = () => migratePg(d, { migrationsFolder });
    conn.closer = () => Promise.all([sql.end({ timeout: 5 }), txSql.end({ timeout: 5 })]).then(() => undefined);
    return (conn.db = d);
  }
  const dir = process.env.PGLITE_DIR ?? resolve(here, "../../../.data/pglite");
  if (!dir.startsWith("memory://")) mkdirSync(dirname(dir), { recursive: true }); // PGlite only creates the leaf dir
  const client = new PGlite(dir);
  const d = drizzlePglite({ client, schema });
  conn.migrator = () => migratePglite(d, { migrationsFolder });
  conn.closer = () => client.close();
  return (conn.db = d);
}

export async function migrate(): Promise<Db> {
  const d = getDb();
  await conn.migrator!();
  return d;
}

/** Release the pool (CLI scripts; postgres-js keeps the process alive otherwise). */
export async function closeDb(): Promise<void> {
  const close = conn.closer;
  conn.db = conn.migrator = conn.closer = undefined;
  await close?.();
}

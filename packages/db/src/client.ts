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

let db: Db | undefined;
let migrator: (() => Promise<void>) | undefined;
let closer: (() => Promise<void>) | undefined;

/**
 * DATABASE_URL → any Postgres over TCP via postgres-js (Supabase pooler, Neon, self-hosted); else PGlite at <repo>/.data/pglite (PGLITE_DIR overrides, `memory://` for tests).
 * prepare:false keeps it safe behind transaction-mode poolers (Supavisor :6543, PgBouncer); small pool + idle timeout suit serverless instances.
 */
export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 });
    const d = drizzlePg({ client: sql, schema });
    migrator = () => migratePg(d, { migrationsFolder });
    closer = () => sql.end({ timeout: 5 });
    return (db = d);
  }
  const dir = process.env.PGLITE_DIR ?? resolve(here, "../../../.data/pglite");
  if (!dir.startsWith("memory://")) mkdirSync(dirname(dir), { recursive: true }); // PGlite only creates the leaf dir
  const client = new PGlite(dir);
  const d = drizzlePglite({ client, schema });
  migrator = () => migratePglite(d, { migrationsFolder });
  closer = () => client.close();
  return (db = d);
}

export async function migrate(): Promise<Db> {
  const d = getDb();
  await migrator!();
  return d;
}

/** Release the pool (CLI scripts; postgres-js keeps the process alive otherwise). */
export async function closeDb(): Promise<void> {
  await closer?.();
  db = migrator = closer = undefined;
}

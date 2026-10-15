import { PGlite } from "@electric-sql/pglite";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { migrate as migrateNeon } from "drizzle-orm/neon-http/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../drizzle");

let db: Db | undefined;
let migrator: (() => Promise<void>) | undefined;

/** DATABASE_URL → Neon (HTTP, no transactions); else PGlite at <repo>/.data/pglite (PGLITE_DIR overrides, `memory://` for tests). */
export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (url) {
    const d = drizzleNeon({ client: neon(url), schema });
    migrator = () => migrateNeon(d, { migrationsFolder });
    return (db = d);
  }
  const d = drizzlePglite({ client: new PGlite(process.env.PGLITE_DIR ?? resolve(here, "../../../.data/pglite")), schema });
  migrator = () => migratePglite(d, { migrationsFolder });
  return (db = d);
}

export async function migrate(): Promise<Db> {
  const d = getDb();
  await migrator!();
  return d;
}

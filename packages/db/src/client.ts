import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema>;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../drizzle");

// Process-wide, not module-level: `next dev` gives RSC pages and route handlers separate module instances, and a second client on the same
// file would race the first one's migrate. globalThis is shared by all of them (same pattern as the event bus).
type Conn = { db?: Db; client?: Client };
const conn: Conn = ((globalThis as { __pmDb?: Conn }).__pmDb ??= {});

/** True when the app talks to a hosted Turso database (shared by every instance, migrated with `db:migrate`, not on start). */
export const hostedDb = (): boolean => !!process.env.TURSO_DATABASE_URL;

/** The libSQL URL in use: TURSO_DATABASE_URL, else DB_FILE (a path, or `:memory:` for tests), else <repo>/.data/polytech.db. */
function localUrl(): string {
  const f = process.env.DB_FILE ?? resolve(here, "../../../.data/polytech.db");
  if (f === ":memory:" || f.startsWith("file:")) return f;
  mkdirSync(dirname(f), { recursive: true });
  return `file:${f}`;
}

/**
 * TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) → hosted Turso over HTTP; else a local libSQL file (DB_FILE overrides, `:memory:` for tests).
 * libsql:// is rewritten to https:// so serverless instances use stateless HTTP requests instead of holding a WebSocket each.
 */
export function getDb(): Db {
  if (conn.db) return conn.db;
  const hosted = process.env.TURSO_DATABASE_URL;
  const url = hosted ? hosted.replace(/^libsql:\/\//, "https://") : localUrl();
  const client = createClient({ url, authToken: hosted ? process.env.TURSO_AUTH_TOKEN : undefined });
  conn.client = client;
  return (conn.db = drizzle({ client, schema }));
}

export async function migrate(): Promise<Db> {
  const d = getDb();
  await migrateLibsql(d, { migrationsFolder });
  return d;
}

/** Close the client (CLI scripts; tests that reopen). */
export async function closeDb(): Promise<void> {
  const c = conn.client;
  conn.db = conn.client = undefined;
  c?.close();
}

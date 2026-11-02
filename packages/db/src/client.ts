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

/**
 * True when the app talks to a hosted Turso database (shared by every instance, migrated by the production build, not on start).
 * DB_FILE wins over TURSO_DATABASE_URL: tests set it (`:memory:`), so exported or pulled Turso credentials can never point a test run at production.
 */
export const hostedDb = (): boolean => !process.env.DB_FILE && !!process.env.TURSO_DATABASE_URL;

/** DB_FILE (a path, a `file:` URL or `:memory:`), else <repo>/.data/polytech.db. */
function localUrl(): string {
  const f = process.env.DB_FILE ?? resolve(here, "../../../.data/polytech.db");
  if (f === ":memory:" || f.startsWith("file:")) return f;
  // Vercel's filesystem is read-only: without Turso credentials the fallback would die in mkdir with an opaque ENOENT.
  if (process.env.VERCEL && !process.env.DB_FILE) {
    throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set in this Vercel environment (preview and production need them); no local database file on Vercel.");
  }
  mkdirSync(dirname(f), { recursive: true });
  return `file:${f}`;
}

/**
 * Hosted Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) when hostedDb(), else a local libSQL file. The Node client sends `libsql://` URLs over HTTPS
 * (plain HTTP with `?tls=0`): stateless requests, no WebSocket held per serverless instance.
 * Local files get a busy timeout: the client pools connections and the libSQL default (0) fails a write at once when another holds the lock.
 */
export function getDb(): Db {
  if (conn.db) return conn.db;
  const client = hostedDb()
    ? createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN })
    : createClient({ url: localUrl(), timeout: 5_000 });
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

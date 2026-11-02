import { Redis as Upstash } from "@upstash/redis";
import { Redis as IORedis } from "ioredis";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { upstashEnv } from "./kv";
import { tables } from "./schema";
import { memoryBackend, type Backend } from "./store/backend";
import { ioredisConn, upstashConn } from "./store/conn";
import { createStore, type Store, type TxDb as TxOf } from "./store/db";
import { redisBackend } from "./store/redis";

export type Db = Store<typeof tables>;
export type TxDb = TxOf<typeof tables>;

const here = dirname(fileURLToPath(import.meta.url));

// Process-wide, not module-level: `next dev` gives RSC pages and route handlers separate module instances, and two in-process stores
// would each hold their own copy. globalThis is shared by all of them (same pattern as the event bus and kv).
type Conn = { db?: Db };
const conn: Conn = ((globalThis as { __pmDb?: Conn }).__pmDb ??= {});

/** Key prefix inside Redis. Keep the {braces}: a hash tag puts every key in one cluster slot, which the Lua scripts need. */
const prefix = () => process.env.REDIS_PREFIX ?? "{pm}:";

/**
 * The store backend, picked from the environment:
 * - UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's KV_REST_API_URL/TOKEN): Upstash over REST. Production on Vercel.
 * - REDIS_URL: any Redis/Valkey over TCP (self-hosted, local redis-server, CI).
 * - neither: in-process, saved to <repo>/.data/store.json (STORE_FILE overrides; `memory://` keeps nothing).
 * - under vitest: always in-process and unsaved, whatever else is set.
 *   Refused in production on Vercel, where instances do not share memory.
 */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): Backend {
  // Tests always get a private in-process store, even with Redis credentials in the shell: suites flush() it between cases.
  // (The store's own conformance suite reaches real Redis through REDIS_TEST_URL and a throwaway prefix.)
  if (env.VITEST) return memoryBackend(env.STORE_FILE && env.STORE_FILE !== "memory://" ? { file: env.STORE_FILE } : {});
  const up = upstashEnv();
  if (up) return redisBackend(upstashConn(new Upstash({ ...up, automaticDeserialization: false })), prefix());
  if (env.REDIS_URL) return redisBackend(ioredisConn(new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 })), prefix());
  if (env.NODE_ENV === "production" && env.VERCEL) {
    throw new Error("UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN) or REDIS_URL required in production on Vercel (the in-process store is per-instance)");
  }
  const file = env.STORE_FILE ?? resolve(here, "../../../.data/store.json");
  return memoryBackend(file === "memory://" ? {} : { file });
}

export function getDb(): Db {
  return (conn.db ??= createStore(backendFromEnv(), tables));
}

/** Release the connection (CLI scripts; ioredis keeps the process alive otherwise) and flush the in-process store to its file. */
export async function closeDb(): Promise<void> {
  const d = conn.db;
  conn.db = undefined;
  await d?.backend.close();
}

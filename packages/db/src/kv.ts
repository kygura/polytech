import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "./client";
import { kvStore } from "./schema";

export interface Kv {
  /** Returns a release fn, or null if held. Auto-expires after ttlMs. */
  lock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null>;
  rateLimit(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; remaining: number }>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

export function memoryKv(): Kv {
  const now = () => Date.now();
  const store = new Map<string, { v: unknown; exp: number }>();
  const hits = new Map<string, { ts: number[]; win: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.exp <= now()) store.delete(k);
    return store.get(k);
  };
  return {
    async lock(key, ttlMs) {
      const k = `lock:${key}`;
      if (live(k)) return null;
      const owner = Symbol();
      store.set(k, { v: owner, exp: now() + ttlMs });
      return async () => { if (live(k)?.v === owner) store.delete(k); };
    },
    async rateLimit(key, limit, windowMs) {
      const t = now();
      if (hits.size > 1000) for (const [k, e] of hits) if ((e.ts.at(-1) ?? 0) <= t - e.win) hits.delete(k); // evict expired
      for (const k of hits.keys()) { if (hits.size <= 10_000) break; hits.delete(k); } // still over cap: drop oldest inserted
      const w = (hits.get(key)?.ts ?? []).filter((x) => x > t - windowMs); // sliding log
      const ok = w.length < limit;
      if (ok) w.push(t);
      hits.delete(key); // re-insert so Map order tracks recency
      hits.set(key, { ts: w, win: windowMs });
      return { ok, remaining: Math.max(0, limit - w.length) };
    },
    async get<T>(key: string) { return (live(key)?.v as T) ?? null; },
    async set(key, value, ttlMs) { store.set(key, { v: value, exp: ttlMs ? now() + ttlMs : Infinity }); },
  };
}

export function upstashKv(redis: Redis): Kv {
  const limiters = new Map<string, Ratelimit>();
  return {
    async lock(key, ttlMs) {
      const k = `lock:${key}`;
      const owner = crypto.randomUUID();
      if (!(await redis.set(k, owner, { nx: true, px: ttlMs }))) return null;
      // Owner-checked release (plain DEL could free a re-acquired lock).
      return async () => {
        await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0", [k], [owner]);
      };
    },
    async rateLimit(key, limit, windowMs) {
      const id = `${limit}:${windowMs}`;
      let rl = limiters.get(id);
      if (!rl) {
        rl = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`), prefix: `rl:${id}` });
        limiters.set(id, rl);
      }
      const r = await rl.limit(key);
      return { ok: r.success, remaining: r.remaining };
    },
    async get<T>(key: string) { return (await redis.get<T>(key)) ?? null; },
    async set(key, value, ttlMs) { await redis.set(key, value, ttlMs ? { px: ttlMs } : undefined); },
  };
}

/**
 * kv on the app's own Postgres (the `kv` table): shared across instances like Upstash, no extra service. Time is the db clock.
 * lock = insert-or-take-over-expired (atomic per statement), released only by its owner. rateLimit = fixed-window counter.
 */
export function pgKv(db: Db): Kv {
  const k = kvStore;
  let calls = 0;
  const prune = () => (++calls % 50 ? undefined : db.delete(k).where(sql`${k.expiresAt} <= now()`).then(() => undefined, () => undefined));
  const until = (ttlMs: number) => sql`now() + ${`${Math.max(1, Math.round(ttlMs))} milliseconds`}::interval`;
  return {
    async lock(key, ttlMs) {
      void prune();
      const id = `lock:${key}`, owner = crypto.randomUUID();
      const got = await db.insert(k).values({ key: id, value: owner, expiresAt: until(ttlMs) as never })
        .onConflictDoUpdate({ target: k.key, set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` }, setWhere: sql`${k.expiresAt} <= now()` })
        .returning({ key: k.key });
      if (!got.length) return null;
      return async () => { await db.delete(k).where(sql`${k.key} = ${id} and ${k.value} = ${JSON.stringify(owner)}::jsonb`); };
    },
    async rateLimit(key, limit, windowMs) {
      const slot = Math.floor(Date.now() / windowMs), id = `rl:${limit}:${windowMs}:${key}:${slot}`;
      const [row] = await db.insert(k).values({ key: id, value: 1, expiresAt: until(windowMs * 2) as never })
        .onConflictDoUpdate({ target: k.key, set: { value: sql`to_jsonb((${k.value} #>> '{}')::bigint + 1)` } })
        .returning({ n: sql<number>`(${k.value} #>> '{}')::bigint` });
      const n = Number(row?.n ?? limit + 1);
      return { ok: n <= limit, remaining: Math.max(0, limit - n) };
    },
    async get<T>(key: string) {
      const [row] = await db.select({ v: k.value }).from(k).where(sql`${k.key} = ${key} and (${k.expiresAt} is null or ${k.expiresAt} > now())`);
      return (row?.v as T | undefined) ?? null;
    },
    async set(key, value, ttlMs) {
      const exp = ttlMs ? until(ttlMs) : null;
      await db.insert(k).values({ key, value: value as never, expiresAt: exp as never })
        .onConflictDoUpdate({ target: k.key, set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` } });
    },
  };
}

let kv: Kv | undefined;
export function getKv(): Kv {
  if (kv) return kv;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return (kv = upstashKv(new Redis({ url, token })));
  // hosted Postgres is shared by every instance: the kv table works there too
  if (process.env.DATABASE_URL) return (kv = pgKv(getDb()));
  // Serverless instances don't share memory, so rate limits/locks would be per-instance: refuse.
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) {
    throw new Error("DATABASE_URL, UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN required in production on Vercel (memory kv is per-instance)");
  }
  if (process.env.NODE_ENV === "production") console.warn("kv: Upstash not configured, using in-memory kv (single process only)");
  return (kv = memoryKv());
}

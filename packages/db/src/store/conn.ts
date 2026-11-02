/** RedisConn adapters: Upstash REST (Vercel, serverless) and ioredis (TCP: self-hosted Redis/Valkey, local redis-server, CI). */
import type { Redis as Upstash } from "@upstash/redis";
import type { Redis as IORedis } from "ioredis";
import type { RedisConn } from "./redis";

/** `redis` must be created with `automaticDeserialization: false` (row blobs and pks are raw strings). */
export function upstashConn(redis: Upstash): RedisConn {
  return {
    evalsha: (sha, keys, args) => redis.evalsha(sha, keys, args),
    eval: (script, keys, args) => redis.eval(script, keys, args),
    async scan(match) {
      const out: string[] = [];
      let cursor: string | number = "0";
      do {
        const [next, ks]: [string | number, string[]] = await redis.scan(cursor, { match, count: 1000 });
        out.push(...ks);
        cursor = next;
      } while (String(cursor) !== "0");
      return out;
    },
    async del(keys) { if (keys.length) await redis.del(...keys); },
    async close() {},
  };
}

export function ioredisConn(redis: IORedis): RedisConn {
  return {
    evalsha: (sha, keys, args) => redis.evalsha(sha, keys.length, ...keys, ...args),
    eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args),
    async scan(match) {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, ks] = await redis.scan(cursor, "MATCH", match, "COUNT", 1000);
        out.push(...ks);
        cursor = next;
      } while (cursor !== "0");
      return out;
    },
    async del(keys) { if (keys.length) await redis.del(...keys); },
    async close() { await redis.quit().catch(() => redis.disconnect()); },
  };
}

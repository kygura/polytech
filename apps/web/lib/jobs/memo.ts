// Short in-process TTL cache with in-flight dedupe: concurrent callers share one promise; a rejection is never cached.
// Per instance only (serverless): it absorbs bursts of identical reads, it is not a source of truth.
const store = new Map<string, { exp: number; v: Promise<unknown> }>();

export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.v as Promise<T>;
  const v = fn().catch((e) => { if (store.get(key)?.v === v) store.delete(key); throw e; });
  store.set(key, { exp: Date.now() + ttlMs, v });
  if (store.size > 500) for (const [k, e] of store) if (e.exp <= Date.now()) store.delete(k);
  return v;
}

/** Drop cached entries whose key starts with `prefix` (all when omitted): writers call this so readers never serve their own stale write. */
export const memoClear = (prefix = "") => { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); };

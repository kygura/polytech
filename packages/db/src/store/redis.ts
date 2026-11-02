/**
 * Redis backend. Layout under `prefix` (default "{pm}:"; the braces are a hash tag, so every key lands in one cluster slot and
 * the Lua scripts may touch any of them):
 *
 *   <p>t:<table>          hash  pk -> "<ver>|<row json>"
 *   <p>i:<index key>      zset  member = pk, score = sort value (0 for unsorted indexes: then member order)
 *   <p>u:<unique key>     hash  value -> owning pk
 *   <p>seq:<table>        string, id sequence
 *   <p>ver                string, store-wide commit counter (row versions)
 *
 * Every read and the commit run as one Lua script each: one round trip, and a commit is atomic.
 */
import { createHash } from "node:crypto";
import type { Backend, Batch, CommitResult, RangeOpts, Stored } from "./backend";

/** The few commands the backend needs; adapters for @upstash/redis (REST) and ioredis (TCP) are in ../client.ts. */
export interface RedisConn {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  scan(match: string): Promise<string[]>;
  del(keys: string[]): Promise<void>;
  close(): Promise<void>;
}

const LUA_HMGET = `
local function hmget(key, ids, from)
  local out = {}
  for i = from, #ids, 500 do
    local part = {}
    for j = i, math.min(i + 499, #ids) do part[#part + 1] = ids[j] end
    local vs = redis.call('HMGET', key, unpack(part))
    for j = 1, #vs do out[#out + 1] = vs[j] end
  end
  return out
end
`;

const S = {
  get: `${LUA_HMGET}
return hmget(KEYS[1], ARGV, 1)`,
  scan: `return redis.call('HGETALL', KEYS[1])`,
  range: `${LUA_HMGET}
local ids
if ARGV[3] == '1' then ids = redis.call('ZRANGE', KEYS[1], ARGV[2], ARGV[1], 'BYSCORE', 'REV', 'LIMIT', ARGV[4], ARGV[5])
else ids = redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2], 'BYSCORE', 'LIMIT', ARGV[4], ARGV[5]) end
if ARGV[6] == '0' or #ids == 0 then return {ids, {}} end
return {ids, hmget(KEYS[2], ids, 1)}`,
  rangeMulti: `${LUA_HMGET}
local all, per = {}, {}
for k = 2, #KEYS do
  local ids
  if ARGV[3] == '1' then ids = redis.call('ZRANGE', KEYS[k], ARGV[2], ARGV[1], 'BYSCORE', 'REV', 'LIMIT', ARGV[4], ARGV[5])
  else ids = redis.call('ZRANGE', KEYS[k], ARGV[1], ARGV[2], 'BYSCORE', 'LIMIT', ARGV[4], ARGV[5]) end
  per[#per + 1] = #ids
  for i = 1, #ids do all[#all + 1] = ids[i] end
end
if #all == 0 then return {per, all, {}} end
return {per, all, hmget(KEYS[1], all, 1)}`,
  rangeIdsMulti: `local per = {}
for k = 1, #KEYS do
  if ARGV[3] == '1' then per[k] = redis.call('ZRANGE', KEYS[k], ARGV[2], ARGV[1], 'BYSCORE', 'REV', 'LIMIT', ARGV[4], ARGV[5])
  else per[k] = redis.call('ZRANGE', KEYS[k], ARGV[1], ARGV[2], 'BYSCORE', 'LIMIT', ARGV[4], ARGV[5]) end
end
return per`,
  pks: `return redis.call('HKEYS', KEYS[1])`,
  count: `return redis.call('ZCOUNT', KEYS[1], ARGV[1], ARGV[2])`,
  owner: `return redis.call('HGET', KEYS[1], ARGV[1])`,
  nextIds: `return redis.call('INCRBY', KEYS[1], ARGV[1])`,
  seqAtLeast: `local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end
return 1`,
  commit: `
local b = cjson.decode(ARGV[1])
local function ver(k, pk)
  local cur = redis.call('HGET', KEYS[k], pk)
  if not cur then return '0' end
  return string.match(cur, '^(%d+)|')
end
for _, e in ipairs(b.e) do
  if ver(e[1], e[2]) ~= e[3] then return {'conflict', KEYS[e[1]] .. ' ' .. e[2]} end
end
local rel = {}
for _, r in ipairs(b.r) do rel[r[1] .. '\\0' .. r[2]] = r[3] end
for _, c in ipairs(b.c) do
  local o = redis.call('HGET', KEYS[c[1]], c[2])
  if o and o ~= c[3] and rel[c[1] .. '\\0' .. c[2]] ~= o then return {'unique', KEYS[c[1]]} end
end
for _, r in ipairs(b.r) do
  if redis.call('HGET', KEYS[r[1]], r[2]) == r[3] then redis.call('HDEL', KEYS[r[1]], r[2]) end
end
for _, c in ipairs(b.c) do redis.call('HSET', KEYS[c[1]], c[2], c[3]) end
if #b.p > 0 then
  local v = redis.call('INCR', KEYS[1])
  for _, p in ipairs(b.p) do redis.call('HSET', KEYS[p[1]], p[2], v .. '|' .. p[3]) end
end
for _, d in ipairs(b.d) do redis.call('HDEL', KEYS[d[1]], d[2]) end
for _, z in ipairs(b.zr) do redis.call('ZREM', KEYS[z[1]], z[2]) end
for _, z in ipairs(b.za) do redis.call('ZADD', KEYS[z[1]], z[2], z[3]) end
return {'ok'}`,
} as const;

const SHA = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, createHash("sha1").update(v).digest("hex")])) as Record<keyof typeof S, string>;

const score = (s: number) => (Number.isFinite(s) ? String(s) : s > 0 ? "+inf" : "-inf");
const lo = (o: RangeOpts) => (o.min === undefined ? "-inf" : (o.minExcl ? "(" : "") + score(o.min));
const hi = (o: RangeOpts) => (o.max === undefined ? "+inf" : (o.maxExcl ? "(" : "") + score(o.max));

/** "<ver>|<json>" -> parts. */
const split = (pk: string, v: string): Stored => {
  const i = v.indexOf("|");
  return { pk, ver: v.slice(0, i), json: v.slice(i + 1) };
};

const globEscape = (s: string) => s.replace(/[*?[\]\\]/g, (c) => "\\" + c);

export function redisBackend(conn: RedisConn, prefix = "{pm}:"): Backend {
  const T = (t: string) => `${prefix}t:${t}`, I = (k: string) => `${prefix}i:${k}`, U = (k: string) => `${prefix}u:${k}`;
  const run = async (name: keyof typeof S, keys: string[], args: string[]) => {
    try {
      return await conn.evalsha(SHA[name], keys, args);
    } catch (e) {
      if (!/NOSCRIPT/i.test(String((e as Error)?.message ?? e))) throw e;
      return conn.eval(S[name], keys, args);
    }
  };
  const rangeArgs = (o: RangeOpts, withRows: boolean) =>
    [lo(o), hi(o), o.rev ? "1" : "0", String(o.offset ?? 0), String(o.limit === undefined ? -1 : o.limit), withRows ? "1" : "0"];

  return {
    kind: "redis",
    async get(t, pks) {
      if (!pks.length) return [];
      const vs = (await run("get", [T(t)], pks)) as (string | null)[];
      return pks.map((pk, i) => (vs[i] ? split(pk, vs[i]!) : null));
    },
    async scan(t) {
      const flat = (await run("scan", [T(t)], [])) as string[];
      const out: Stored[] = [];
      for (let i = 0; i < flat.length; i += 2) out.push(split(flat[i]!, flat[i + 1]!));
      return out;
    },
    async range(k, t, o = {}) {
      if (o.limit === 0) return [];
      const [ids, vs] = (await run("range", [I(k), T(t)], rangeArgs(o, true))) as [string[], (string | null)[]];
      const out: Stored[] = [];
      ids.forEach((pk, i) => { if (vs[i]) out.push(split(pk, vs[i]!)); });
      return out;
    },
    async rangeMulti(ks, t, o = {}) {
      if (o.limit === 0) return ks.map(() => []);
      const out: Stored[][] = [];
      for (let c = 0; c < ks.length; c += 100) {
        const part = ks.slice(c, c + 100);
        const [per, ids, vs] = (await run("rangeMulti", [T(t), ...part.map(I)], rangeArgs(o, true))) as [number[], string[], (string | null)[]];
        let at = 0;
        for (const n of per) {
          const list: Stored[] = [];
          for (let i = at; i < at + Number(n); i++) if (vs[i]) list.push(split(ids[i]!, vs[i]!));
          out.push(list);
          at += Number(n);
        }
      }
      return out;
    },
    async rangeIdsMulti(ks, o = {}) {
      if (o.limit === 0) return ks.map(() => []);
      const out: string[][] = [];
      for (let c = 0; c < ks.length; c += 200) out.push(...((await run("rangeIdsMulti", ks.slice(c, c + 200).map(I), rangeArgs(o, false))) as string[][]));
      return out;
    },
    async partitions(t, index) {
      const p = I(`${t}:${index}:`);
      return [...new Set(await conn.scan(`${globEscape(p)}*`))].map((k) => k.slice(p.length));
    },
    async pks(t) { return (await run("pks", [T(t)], [])) as string[]; },
    async rangeIds(k, o = {}) {
      if (o.limit === 0) return [];
      return ((await run("range", [I(k), T("_")], rangeArgs(o, false))) as [string[]])[0];
    },
    async count(k, o = {}) { return Number(await run("count", [I(k)], [lo(o), hi(o)])); },
    async owner(k, v) { return ((await run("owner", [U(k)], [v])) as string | null) ?? null; },
    async commit(b: Batch): Promise<CommitResult> {
      const keys = [`${prefix}ver`], at = new Map<string, number>(), logical = new Map<string, string>();
      const ix = (phys: string, log: string) => {
        let i = at.get(phys);
        if (i === undefined) { keys.push(phys); at.set(phys, (i = keys.length)); logical.set(phys, log); }
        return i;
      };
      const payload = {
        e: b.expect.map((e) => [ix(T(e.t), e.t), e.pk, e.ver]),
        c: b.claim.map((c) => [ix(U(c.k), c.k), c.v, c.pk]),
        r: b.release.map((r) => [ix(U(r.k), r.k), r.v, r.pk]),
        p: b.put.map((p) => [ix(T(p.t), p.t), p.pk, p.json]),
        d: b.del.map((d) => [ix(T(d.t), d.t), d.pk]),
        zr: b.zrem.map((z) => [ix(I(z.k), z.k), z.m]),
        za: b.zadd.map((z) => [ix(I(z.k), z.k), score(z.s), z.m]),
      };
      const [res, key] = (await run("commit", keys, [JSON.stringify(payload)])) as [string, string?];
      if (res === "ok") return { ok: true };
      const phys = key?.split(" ")[0] ?? "";
      return { ok: false, reason: res === "unique" ? "unique" : "conflict", key: logical.get(phys) ?? key ?? "" };
    },
    async nextIds(t, n) { return Number(await run("nextIds", [`${prefix}seq:${t}`], [String(n)])); },
    async seqAtLeast(t, n) { await run("seqAtLeast", [`${prefix}seq:${t}`], [String(n)]); },
    async flush() {
      const ks = await conn.scan(`${globEscape(prefix)}*`);
      for (let i = 0; i < ks.length; i += 500) await conn.del(ks.slice(i, i + 500));
    },
    close: () => conn.close(),
  };
}

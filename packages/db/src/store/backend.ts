/**
 * Storage backends for the row store. A backend knows nothing about columns or indexes: it holds versioned row blobs per table,
 * sorted sets (indexes), value->pk hashes (unique constraints) and id sequences, and applies a whole write batch atomically.
 *
 * Every row carries a version (a store-wide commit counter, so a deleted-then-recreated row never reuses an old version).
 * A batch lists the versions its writes were computed from; the commit fails with "conflict" if any changed, so callers
 * get compare-and-set and retry (see db.ts).
 */
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Stored = { pk: string; ver: string; json: string };

export interface RangeOpts {
  min?: number;
  max?: number;
  minExcl?: boolean;
  maxExcl?: boolean;
  rev?: boolean;
  offset?: number;
  limit?: number;
}

/** Keys are logical (table, index and unique names); the backend maps them to its own storage. */
export interface Batch {
  /** Row versions the batch was computed from. "0" = the row must not exist. */
  expect: { t: string; pk: string; ver: string }[];
  /** Unique values to own; fails with "unique" if another pk owns one. */
  claim: { k: string; v: string; pk: string }[];
  /** Unique values to give up (only if this pk still owns them). */
  release: { k: string; v: string; pk: string }[];
  put: { t: string; pk: string; json: string }[];
  del: { t: string; pk: string }[];
  /** Index members to add, applied after `zrem`. Score is a number or ±Infinity. */
  zadd: { k: string; s: number; m: string }[];
  zrem: { k: string; m: string }[];
}

export type CommitResult = { ok: true } | { ok: false; reason: "conflict" | "unique"; key: string };

export interface Backend {
  readonly kind: "memory" | "redis";
  get(t: string, pks: string[]): Promise<(Stored | null)[]>;
  scan(t: string): Promise<Stored[]>;
  /** Members of index `k` by score (ties in member order), with their rows from table `t`. Members whose row is gone are skipped. */
  range(k: string, t: string, o?: RangeOpts): Promise<Stored[]>;
  /** `range` over several indexes of the same table in one round trip; one result list per key, in key order. */
  rangeMulti(ks: string[], t: string, o?: RangeOpts): Promise<Stored[][]>;
  rangeIds(k: string, o?: RangeOpts): Promise<string[]>;
  rangeIdsMulti(ks: string[], o?: RangeOpts): Promise<string[][]>;
  /** Partition suffixes of index `<t>:<index>` that hold at least one member (the joined `on` values). */
  partitions(t: string, index: string): Promise<string[]>;
  /** Every primary key of a table (no row data). */
  pks(t: string): Promise<string[]>;
  count(k: string, o?: RangeOpts): Promise<number>;
  /** pk that owns unique value `v` in `k`, or null. */
  owner(k: string, v: string): Promise<string | null>;
  commit(b: Batch): Promise<CommitResult>;
  /** Reserve `n` ids; returns the last one (ids are last-n+1 .. last). */
  nextIds(t: string, n: number): Promise<number>;
  /** Move the sequence forward to at least `n` (imports). */
  seqAtLeast(t: string, n: number): Promise<void>;
  /** Delete everything this store holds. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const emptyBatch = (): Batch => ({ expect: [], claim: [], release: [], put: [], del: [], zadd: [], zrem: [] });

const inRange = (s: number, o: RangeOpts) =>
  (o.min === undefined || (o.minExcl ? s > o.min : s >= o.min)) && (o.max === undefined || (o.maxExcl ? s < o.max : s <= o.max));

const page = <T>(xs: T[], o: RangeOpts) => {
  const from = o.offset ?? 0;
  return o.limit === undefined || o.limit < 0 ? xs.slice(from) : xs.slice(from, from + o.limit);
};

/** Redis orders equal scores by member bytes; for the ASCII ids used here code-unit order is the same. */
const byScoreThenMember = (a: [string, number], b: [string, number]) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

type MemState = {
  ver: number;
  rows: Map<string, Map<string, { ver: string; json: string }>>;
  zsets: Map<string, Map<string, number>>;
  uniq: Map<string, Map<string, string>>;
  seq: Map<string, number>;
};

const freshState = (): MemState => ({ ver: 0, rows: new Map(), zsets: new Map(), uniq: new Map(), seq: new Map() });
const sub = <K, V>(m: Map<string, Map<K, V>>, k: string) => {
  let x = m.get(k);
  if (!x) m.set(k, (x = new Map()));
  return x;
};

/**
 * In-process backend: tests, and local dev without Redis. With `file`, state is loaded from and saved to that JSON file
 * (debounced, plus on exit), so `bun run dev` keeps its data across restarts. One process per file.
 */
export function memoryBackend(opts: { file?: string } = {}): Backend {
  let st = freshState();
  const file = opts.file;
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        ver: number;
        rows: [string, [string, { ver: string; json: string }][]][];
        zsets: [string, [string, number | string][]][];
        uniq: [string, [string, string][]][];
        seq: [string, number][];
      };
      st = {
        ver: raw.ver,
        rows: new Map(raw.rows.map(([k, v]) => [k, new Map(v)])),
        zsets: new Map(raw.zsets.map(([k, v]) => [k, new Map(v.map(([m, s]) => [m, Number(s)]))])), // ±Infinity is saved as a string
        uniq: new Map(raw.uniq.map(([k, v]) => [k, new Map(v)])),
        seq: new Map(raw.seq),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`store file ${file} is unreadable: ${(e as Error).message}`);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const save = () => {
    if (!file || !dirty) return;
    dirty = false;
    const out = {
      ver: st.ver,
      rows: [...st.rows].map(([k, v]) => [k, [...v]]),
      zsets: [...st.zsets].map(([k, v]) => [k, [...v].map(([m, s]) => [m, Number.isFinite(s) ? s : String(s)])]),
      uniq: [...st.uniq].map(([k, v]) => [k, [...v]]),
      seq: [...st.seq],
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(out));
    renameSync(`${file}.tmp`, file);
  };
  const touch = () => {
    if (!file) return;
    dirty = true;
    timer ??= setTimeout(() => ((timer = undefined), save()), 250);
    (timer as { unref?: () => void }).unref?.();
  };
  if (file) process.once("beforeExit", save).once("exit", save);

  const zrange = (k: string, o: RangeOpts) => {
    const z = st.zsets.get(k);
    if (!z) return [];
    const xs = [...z].filter(([, s]) => inRange(s, o)).sort(byScoreThenMember);
    if (o.rev) xs.reverse();
    return page(xs, o).map(([m]) => m);
  };
  const row = (t: string, pk: string): Stored | null => {
    const r = st.rows.get(t)?.get(pk);
    return r ? { pk, ver: r.ver, json: r.json } : null;
  };

  return {
    kind: "memory",
    async get(t, pks) { return pks.map((pk) => row(t, pk)); },
    async scan(t) { return [...(st.rows.get(t) ?? [])].map(([pk, r]) => ({ pk, ver: r.ver, json: r.json })); },
    async range(k, t, o = {}) { return zrange(k, o).map((pk) => row(t, pk)).filter((x): x is Stored => !!x); },
    async rangeMulti(ks, t, o = {}) { return ks.map((k) => zrange(k, o).map((pk) => row(t, pk)).filter((x): x is Stored => !!x)); },
    async rangeIds(k, o = {}) { return zrange(k, o); },
    async rangeIdsMulti(ks, o = {}) { return ks.map((k) => zrange(k, o)); },
    async partitions(t, index) {
      const p = `${t}:${index}:`;
      return [...st.zsets.keys()].filter((k) => k.startsWith(p) && st.zsets.get(k)!.size).map((k) => k.slice(p.length));
    },
    async pks(t) { return [...(st.rows.get(t)?.keys() ?? [])]; },
    async count(k, o = {}) { return [...(st.zsets.get(k)?.values() ?? [])].filter((s) => inRange(s, o)).length; },
    async owner(k, v) { return st.uniq.get(k)?.get(v) ?? null; },
    async commit(b) {
      for (const e of b.expect) if ((st.rows.get(e.t)?.get(e.pk)?.ver ?? "0") !== e.ver) return { ok: false, reason: "conflict", key: `${e.t}:${e.pk}` };
      const rel = new Map(b.release.map((r) => [`${r.k}\u0000${r.v}`, r.pk]));
      for (const c of b.claim) {
        const o = st.uniq.get(c.k)?.get(c.v);
        if (o !== undefined && o !== c.pk && rel.get(`${c.k}\u0000${c.v}`) !== o) return { ok: false, reason: "unique", key: c.k };
      }
      for (const r of b.release) if (st.uniq.get(r.k)?.get(r.v) === r.pk) st.uniq.get(r.k)!.delete(r.v);
      for (const c of b.claim) sub(st.uniq, c.k).set(c.v, c.pk);
      if (b.put.length) {
        const ver = String(++st.ver);
        for (const p of b.put) sub(st.rows, p.t).set(p.pk, { ver, json: p.json });
      }
      for (const d of b.del) st.rows.get(d.t)?.delete(d.pk);
      for (const z of b.zrem) {
        const s = st.zsets.get(z.k);
        if (s) { s.delete(z.m); if (!s.size) st.zsets.delete(z.k); }
      }
      for (const z of b.zadd) sub(st.zsets, z.k).set(z.m, z.s);
      touch();
      return { ok: true };
    },
    async nextIds(t, n) {
      const last = (st.seq.get(t) ?? 0) + n;
      st.seq.set(t, last);
      touch();
      return last;
    },
    async seqAtLeast(t, n) {
      if ((st.seq.get(t) ?? 0) < n) st.seq.set(t, n);
      touch();
    },
    async flush() { st = freshState(); touch(); },
    async close() { if (timer) clearTimeout(timer); timer = undefined; save(); },
  };
}

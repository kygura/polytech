/**
 * The row store: typed handles per table over a Backend, with optimistic transactions.
 *
 * Every write runs in a transaction: point reads record the row version they saw, writes are buffered, and the commit
 * (one atomic backend call) fails if any of those rows changed since; the transaction function then runs again on fresh
 * data. So `update(pk, fn)` is a compare-and-set, `insert` cannot overwrite, and `db.tx` gives multi-row, multi-table atomic
 * writes. Keep side effects (network calls, events) out of transaction functions: they may run more than once.
 *
 * Index reads (`find`, `all`, `count`) are not tracked: inside a transaction they read committed data and do not see the
 * transaction's own writes. Re-read rows by key (`get`) when a decision depends on them.
 */
import { emptyBatch, type Backend, type Batch, type RangeOpts } from "./backend";
import {
  decode, encode, indexEntries, indexKey, normalize, part, patchRow, pkArg, pkOf, uniqueEntries, uniqueKey,
  type IndexSpec, type Insert, type Row, type TableDef,
} from "./table";

type Rec = Record<string, unknown>;

export class UniqueViolation extends Error {
  constructor(readonly table: string, readonly constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
    this.name = "UniqueViolation";
  }
}
export class WriteConflict extends Error {
  constructor(key: string) {
    super(`write conflict on ${key}: retries exhausted`);
    this.name = "WriteConflict";
  }
}

const k2 = (t: TableDef, pk: string) => `${t.name}\u0000${pk}`;

export class Tx {
  readonly reads = new Map<string, { t: TableDef; pk: string; ver: string; row: Rec | null }>();
  readonly writes = new Map<string, { t: TableDef; pk: string; row: Rec | null }>();
  constructor(readonly b: Backend) {}

  /** Current rows for pks (this transaction's own writes win), loading and recording versions for unseen ones. */
  async load(t: TableDef, pks: string[]): Promise<(Rec | null)[]> {
    const missing = [...new Set(pks.filter((pk) => !this.reads.has(k2(t, pk)) && !this.writes.has(k2(t, pk))))];
    if (missing.length) {
      const got = await this.b.get(t.name, missing);
      missing.forEach((pk, i) => {
        const s = got[i];
        this.reads.set(k2(t, pk), { t, pk, ver: s?.ver ?? "0", row: s ? decode(t, s.json) : null });
      });
    }
    return pks.map((pk) => {
      const w = this.writes.get(k2(t, pk));
      return w ? w.row : (this.reads.get(k2(t, pk))?.row ?? null);
    });
  }

  /** A fresh serial id cannot exist yet: skip the read, still commit with "must not exist". */
  assumeAbsent(t: TableDef, pk: string) {
    if (!this.reads.has(k2(t, pk))) this.reads.set(k2(t, pk), { t, pk, ver: "0", row: null });
  }

  async write(t: TableDef, pk: string, row: Rec | null) {
    if (!this.reads.has(k2(t, pk))) await this.load(t, [pk]);
    this.writes.set(k2(t, pk), { t, pk, row });
  }

  build(): Batch {
    const b = emptyBatch();
    const claimed = new Map<string, string>();
    for (const [key, w] of this.writes) {
      const r = this.reads.get(key)!;
      b.expect.push({ t: w.t.name, pk: w.pk, ver: r.ver });
      const old = r.row, nu = w.row;
      const oi = old ? indexEntries(w.t, old) : new Map<string, number>(), ni = nu ? indexEntries(w.t, nu) : new Map<string, number>();
      for (const ik of oi.keys()) if (!ni.has(ik)) b.zrem.push({ k: ik, m: w.pk });
      for (const [ik, s] of ni) if (oi.get(ik) !== s) b.zadd.push({ k: ik, s, m: w.pk });
      const ou = old ? uniqueEntries(w.t, old) : new Map<string, string>(), nuq = nu ? uniqueEntries(w.t, nu) : new Map<string, string>();
      for (const [uk, v] of ou) if (nuq.get(uk) !== v) b.release.push({ k: uk, v, pk: w.pk });
      for (const [uk, v] of nuq) {
        const prev = claimed.get(`${uk}\u0000${v}`);
        if (prev !== undefined && prev !== w.pk) throw new UniqueViolation(w.t.name, uk.replace(":", "_"));
        claimed.set(`${uk}\u0000${v}`, w.pk);
        if (ou.get(uk) !== v) b.claim.push({ k: uk, v, pk: w.pk });
      }
      if (nu) b.put.push({ t: w.t.name, pk: w.pk, json: encode(w.t, nu) });
      else if (old) b.del.push({ t: w.t.name, pk: w.pk });
    }
    for (const [key, r] of this.reads) if (!this.writes.has(key)) b.expect.push({ t: r.t.name, pk: r.pk, ver: r.ver });
    return b;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTx<T>(b: Backend, fn: (tx: Tx) => Promise<T>, tries = 12): Promise<T> {
  for (let i = 0; ; i++) {
    const tx = new Tx(b);
    const out = await fn(tx);
    if (!tx.writes.size) return out;
    const res = await b.commit(tx.build());
    if (res.ok) return out;
    if (res.reason === "unique") throw new UniqueViolation(res.key.split(":")[0] ?? "", res.key.replace(":", "_"));
    if (i >= tries) throw new WriteConflict(res.key);
    await sleep(Math.min(100, 2 ** i) * (0.5 + Math.random()));
  }
}

// ---- handles ----

export interface FindOpts {
  /** score >= min */ min?: number | Date;
  /** score > gt */ gt?: number | Date;
  /** score <= max */ max?: number | Date;
  /** score < lt */ lt?: number | Date;
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
}
type IxOf<T> = T extends TableDef<string, infer _C, infer IX> ? IX : never;
type MatchOf<R, S> = S extends { on: readonly (infer K)[] } ? { [P in K & keyof R]: R[P] } : never;
export type Match<T extends TableDef, I extends keyof IxOf<T>> = MatchOf<Row<T>, IxOf<T>[I]>;
export type PkArg = string | number | readonly (string | number | boolean | Date | null)[];
type Patch<T extends TableDef> = Partial<Row<T>>;
type SetFn<T extends TableDef> = (cur: Row<T>) => Partial<Row<T>> | null | undefined | false;

const ms = (v: number | Date | undefined) => (v instanceof Date ? v.getTime() : v);
const rangeOf = (o: FindOpts): RangeOpts => {
  const r: RangeOpts = { rev: o.order === "desc", offset: o.offset, limit: o.limit };
  if (o.gt !== undefined) { r.min = ms(o.gt); r.minExcl = true; } else if (o.min !== undefined) r.min = ms(o.min);
  if (o.lt !== undefined) { r.max = ms(o.lt); r.maxExcl = true; } else if (o.max !== undefined) r.max = ms(o.max);
  return r;
};

/** Split bulk writes so one commit stays well under REST request limits (Upstash: 1 MB on the free plan). */
const chunk = <X>(xs: X[], maxRows = 200, maxBytes = 256_000) => {
  const out: X[][] = [];
  let cur: X[] = [], bytes = 0;
  for (const x of xs) {
    const n = JSON.stringify(x)?.length ?? 0;
    if (cur.length && (cur.length >= maxRows || bytes + n > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(x); bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
};

type Exec = { b: Backend; run<X>(fn: (tx: Tx) => Promise<X>): Promise<X>; inTx: boolean };

export class Handle<T extends TableDef> {
  constructor(readonly def: T, private readonly x: Exec) {}
  private get t(): TableDef { return this.def; }
  private dec = (json: string) => decode(this.t, json) as Row<T>;

  // -- reads --
  async get(pk: PkArg): Promise<Row<T> | null> {
    const id = pkArg(this.t, pk);
    return this.x.run(async (tx) => (await tx.load(this.t, [id]))[0] as Row<T> | null);
  }
  /** Existing rows for `pks`, in input order (missing ones skipped). */
  async getMany(pks: readonly PkArg[]): Promise<Row<T>[]> {
    if (!pks.length) return [];
    const ids = pks.map((p) => pkArg(this.t, p));
    return this.x.run(async (tx) => (await tx.load(this.t, ids)).filter(Boolean) as Row<T>[]);
  }
  /** Every row (full scan: small tables only). */
  async all(): Promise<Row<T>[]> { return (await this.x.b.scan(this.t.name)).map((s) => this.dec(s.json)); }

  /** Rows in an index partition (or several, merged), ordered by the index's sort field then pk. */
  async find<I extends keyof IxOf<T> & string>(index: I, match: Match<T, I> | readonly Match<T, I>[], o: FindOpts = {}): Promise<Row<T>[]> {
    const list = Array.isArray(match) ? match : [match];
    if (!list.length) return [];
    if (list.length === 1) return (await this.x.b.range(indexKey(this.t, index, list[0] as Rec), this.t.name, rangeOf(o))).map((s) => this.dec(s.json));
    const per = { ...o, offset: 0, limit: o.limit === undefined ? undefined : (o.offset ?? 0) + o.limit };
    const parts = await this.x.b.rangeMulti(list.map((m) => indexKey(this.t, index, m as Rec)), this.t.name, rangeOf(per));
    const ix = this.t.indexes[index] as IndexSpec<Rec>;
    const score = (r: Rec) => { const v = ix.sort ? r[ix.sort] : 0; return v instanceof Date ? v.getTime() : typeof v === "number" ? v : v == null ? -Infinity : Number(v); };
    const seen = new Set<string>();
    const rows = parts.flat().filter((s) => !seen.has(s.pk) && !!seen.add(s.pk)).map((s) => ({ pk: s.pk, r: this.dec(s.json) as Rec }));
    rows.sort((a, b) => (score(a.r) - score(b.r)) || (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));
    if (o.order === "desc") rows.reverse();
    const from = o.offset ?? 0;
    return rows.slice(from, o.limit === undefined ? undefined : from + o.limit).map((x) => x.r as Row<T>);
  }
  /** `find` per match, in one round trip per ~100 partitions: e.g. the newest row of each of 1000 markets ({ order: "desc", limit: 1 }). */
  async findEach<I extends keyof IxOf<T> & string>(index: I, matches: readonly Match<T, I>[], o: FindOpts = {}): Promise<Row<T>[][]> {
    if (!matches.length) return [];
    const got = await this.x.b.rangeMulti(matches.map((m) => indexKey(this.t, index, m as Rec)), this.t.name, rangeOf(o));
    return got.map((list) => list.map((s) => this.dec(s.json)));
  }
  /** `ids` per match, batched. */
  async idsEach<I extends keyof IxOf<T> & string>(index: I, matches: readonly Match<T, I>[], o: FindOpts = {}): Promise<string[][]> {
    if (!matches.length) return [];
    return this.x.b.rangeIdsMulti(matches.map((m) => indexKey(this.t, index, m as Rec)), rangeOf(o));
  }
  /** Distinct values of a one-field index that currently hold rows (e.g. every conditionId with history). Null shows as null. */
  async distinct<I extends keyof IxOf<T> & string>(index: I): Promise<(string | null)[]> {
    const ix = this.t.indexes[index] as IndexSpec<Rec> | undefined;
    if (!ix || ix.on.length !== 1) throw new Error(`distinct: ${this.t.name}.${index} must be a one-field index`);
    return (await this.x.b.partitions(this.t.name, index)).map((p) => (p === "\u0000" ? null : p));
  }
  /** Every primary key (no row data). Composite keys come back joined. */
  async pks(): Promise<string[]> { return this.x.b.pks(this.t.name); }
  async first<I extends keyof IxOf<T> & string>(index: I, match: Match<T, I> | readonly Match<T, I>[], o: Omit<FindOpts, "limit"> = {}): Promise<Row<T> | null> {
    return (await this.find(index, match, { ...o, limit: 1 }))[0] ?? null;
  }
  /** Primary keys in an index partition (cheap: no row fetch). Composite keys come back joined; pass them to get/update as-is. */
  async ids<I extends keyof IxOf<T> & string>(index: I, match: Match<T, I>, o: FindOpts = {}): Promise<string[]> {
    return this.x.b.rangeIds(indexKey(this.t, index, match as Rec), rangeOf(o));
  }
  async count<I extends keyof IxOf<T> & string>(index: I, match: Match<T, I>, o: Omit<FindOpts, "order" | "offset" | "limit"> = {}): Promise<number> {
    return this.x.b.count(indexKey(this.t, index, match as Rec), rangeOf(o));
  }
  /** Row holding a unique value (constraint name = column name for `.unique()` columns). */
  async byUnique(name: string, match: Partial<Row<T>>): Promise<Row<T> | null> {
    const { k, v } = uniqueKey(this.t, name, match as Rec);
    const pk = await this.x.b.owner(k, v);
    return pk === null ? null : this.get(pk);
  }

  // -- writes --
  private async prepare(tx: Tx, rows: readonly Insert<T>[]) {
    const full = rows.map((r) => normalize(this.t, r as Rec));
    const s = this.t.serial;
    if (s) {
      const need = full.filter((r) => r[s] === null || r[s] === undefined);
      if (need.length) {
        const last = await tx.b.nextIds(this.t.name, need.length);
        need.forEach((r, i) => { r[s] = last - need.length + 1 + i; tx.assumeAbsent(this.t, part(r[s])); });
      }
    }
    return full;
  }
  private pkey = () => `${this.t.name}_pkey`;

  /** Insert; throws UniqueViolation if the key or a unique value is taken. */
  async insert(row: Insert<T>): Promise<Row<T>> { return (await this.insertMany([row]))[0]!; }
  /** Insert all, atomically per chunk of ~200 rows (atomically as a whole inside db.tx). */
  async insertMany(rows: readonly Insert<T>[]): Promise<Row<T>[]> {
    const go = (rs: readonly Insert<T>[]) => this.x.run(async (tx) => {
      const full = await this.prepare(tx, rs);
      const ids = full.map((r) => pkOf(this.t, r));
      if (new Set(ids).size < ids.length) throw new UniqueViolation(this.t.name, this.pkey());
      const cur = await tx.load(this.t, ids);
      if (cur.some(Boolean)) throw new UniqueViolation(this.t.name, this.pkey());
      for (let i = 0; i < full.length; i++) await tx.write(this.t, ids[i]!, full[i]!);
      return full as Row<T>[];
    });
    if (this.x.inTx) return go(rows);
    const out: Row<T>[] = [];
    for (const c of chunk([...rows])) out.push(...(await go(c)));
    return out;
  }
  /** Insert unless the key or a unique value is taken (ON CONFLICT DO NOTHING). Returns the row, or null. */
  async insertIfAbsent(row: Insert<T>): Promise<Row<T> | null> {
    const run = () => this.x.run(async (tx) => {
      const [full] = await this.prepare(tx, [row]);
      const id = pkOf(this.t, full!);
      if ((await tx.load(this.t, [id]))[0]) return null;
      for (const [k, v] of uniqueEntries(this.t, full!)) {
        const owner = await tx.b.owner(k, v);
        if (owner !== null && owner !== id) return null;
      }
      await tx.write(this.t, id, full!);
      return full as Row<T>;
    });
    try {
      return await run();
    } catch (e) {
      if (e instanceof UniqueViolation && !this.x.inTx) return null; // lost a race for a unique value
      throw e;
    }
  }
  /**
   * Insert, or update the existing row with the same key (ON CONFLICT (pk) DO UPDATE). `set` is a patch, or a function of the
   * current row returning one (null/false = leave it); default = the inserted values.
   */
  async upsert(row: Insert<T>, set?: Patch<T> | SetFn<T>): Promise<Row<T>> { return (await this.upsertMany([row], set))[0]!; }
  async upsertMany(rows: readonly Insert<T>[], set?: Patch<T> | SetFn<T>): Promise<Row<T>[]> {
    const go = (rs: readonly Insert<T>[]) => this.x.run(async (tx) => {
      const full = await this.prepare(tx, rs);
      const ids = full.map((r) => pkOf(this.t, r));
      const cur = await tx.load(this.t, ids);
      const out: Row<T>[] = [];
      for (let i = 0; i < full.length; i++) {
        const c = i === 0 ? cur[0] : (await tx.load(this.t, [ids[i]!]))[0]; // sees this batch's own earlier writes (duplicate keys)
        if (!c) { await tx.write(this.t, ids[i]!, full[i]!); out.push(full[i] as Row<T>); continue; }
        const p = set === undefined ? (rs[i] as Rec) : typeof set === "function" ? set(c as Row<T>) : set;
        if (!p) { out.push(c as Row<T>); continue; }
        const nu = patchRow(this.t, c, p as Rec);
        await tx.write(this.t, ids[i]!, nu);
        out.push(nu as Row<T>);
      }
      return out;
    });
    const retry = async (rs: readonly Insert<T>[]) => {
      for (let i = 0; ; i++) {
        try { return await go(rs); } catch (e) { if (!(e instanceof UniqueViolation) || this.x.inTx || i >= 3) throw e; }
      }
    };
    if (this.x.inTx) return go(rows);
    const out: Row<T>[] = [];
    for (const c of chunk([...rows])) out.push(...(await retry(c)));
    return out;
  }
  /**
   * Upsert keyed by a unique constraint instead of the primary key (ON CONFLICT (<unique cols>) DO UPDATE): the row holding the
   * value is patched with `set` (default: the inserted values minus the primary key), else `row` is inserted.
   */
  async upsertBy(unique: string, row: Insert<T>, set?: Patch<T> | SetFn<T>): Promise<Row<T>> {
    const go = () => this.x.run(async (tx) => {
      const { k, v } = uniqueKey(this.t, unique, normalize(this.t, row as Rec));
      const pk = await tx.b.owner(k, v);
      const cur = pk === null ? null : (await tx.load(this.t, [pk]))[0];
      if (!cur) {
        const [full] = await this.prepare(tx, [row]);
        const id = pkOf(this.t, full!);
        if ((await tx.load(this.t, [id]))[0]) throw new UniqueViolation(this.t.name, this.pkey());
        await tx.write(this.t, id, full!);
        return full as Row<T>;
      }
      const p = set === undefined ? Object.fromEntries(Object.entries(row as Rec).filter(([c]) => !this.t.pk.includes(c))) : typeof set === "function" ? set(cur as Row<T>) : set;
      if (!p) return cur as Row<T>;
      const nu = patchRow(this.t, cur, p as Rec);
      await tx.write(this.t, pk!, nu);
      return nu as Row<T>;
    });
    for (let i = 0; ; i++) {
      try { return await go(); } catch (e) { if (!(e instanceof UniqueViolation) || this.x.inTx || i >= 3) throw e; }
    }
  }
  /** Compare-and-set update: `set` is a patch, or a function of the current row (null/false = no change). Returns the new row, or null if missing/unchanged. */
  async update(pk: PkArg, set: Patch<T> | SetFn<T>): Promise<Row<T> | null> {
    return (await this.updateMany([pk], set))[0] ?? null;
  }
  /** `update` for many keys; atomic per chunk. Returns the rows that changed. */
  async updateMany(pks: readonly PkArg[], set: Patch<T> | SetFn<T>): Promise<Row<T>[]> {
    const go = (ids: string[]) => this.x.run(async (tx) => {
      const cur = await tx.load(this.t, ids);
      const out: Row<T>[] = [];
      for (let i = 0; i < ids.length; i++) {
        const c = cur[i];
        if (!c) continue;
        const p = typeof set === "function" ? set(c as Row<T>) : set;
        if (!p) continue;
        const nu = patchRow(this.t, c, p as Rec);
        await tx.write(this.t, ids[i]!, nu);
        out.push(nu as Row<T>);
      }
      return out;
    });
    const ids = [...new Set(pks.map((p) => pkArg(this.t, p)))];
    if (this.x.inTx) return go(ids);
    const out: Row<T>[] = [];
    for (const c of chunk(ids, 200)) out.push(...(await go(c)));
    return out;
  }
  /** Delete; with `when`, only if it holds for the current row. Returns the deleted row or null. */
  async delete(pk: PkArg, when?: (cur: Row<T>) => boolean): Promise<Row<T> | null> {
    return (await this.deleteMany([pk], when))[0] ?? null;
  }
  async deleteMany(pks: readonly PkArg[], when?: (cur: Row<T>) => boolean): Promise<Row<T>[]> {
    const go = (ids: string[]) => this.x.run(async (tx) => {
      const cur = await tx.load(this.t, ids);
      const out: Row<T>[] = [];
      for (let i = 0; i < ids.length; i++) {
        const c = cur[i];
        if (!c || (when && !when(c as Row<T>))) continue;
        await tx.write(this.t, ids[i]!, null);
        out.push(c as Row<T>);
      }
      return out;
    });
    const ids = [...new Set(pks.map((p) => pkArg(this.t, p)))];
    if (this.x.inTx) return go(ids);
    const out: Row<T>[] = [];
    for (const c of chunk(ids, 200)) out.push(...(await go(c)));
    return out;
  }
}

export type Tables = Record<string, TableDef>;
export type Handles<S extends Tables> = { readonly [K in keyof S]: Handle<S[K]> };
export type TxDb<S extends Tables> = Handles<S>;
export type Store<S extends Tables> = Handles<S> & {
  /** Atomic multi-row, multi-table transaction (optimistic: `fn` re-runs on conflict, so keep side effects out of it). */
  tx<X>(fn: (tx: TxDb<S>) => Promise<X>): Promise<X>;
  readonly backend: Backend;
  /** Delete everything (tests, imports). */
  flush(): Promise<void>;
};

const handles = <S extends Tables>(tables: S, x: Exec) =>
  Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, new Handle(t, x)])) as unknown as Handles<S>;

export function createStore<S extends Tables>(b: Backend, tables: S): Store<S> {
  const top = handles(tables, { b, run: (fn) => runTx(b, fn), inTx: false });
  return Object.assign(Object.create(null), top, {
    tx: <X>(fn: (tx: TxDb<S>) => Promise<X>) => runTx(b, (tx) => fn(handles(tables, { b, run: (f) => f(tx), inTx: true }))),
    backend: b,
    flush: () => b.flush(),
  }) as Store<S>;
}

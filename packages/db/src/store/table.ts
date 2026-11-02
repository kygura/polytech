/**
 * Table definitions: columns (types, nullability, defaults), primary key, secondary indexes and unique constraints.
 * Shaped like the Drizzle schema it replaces, so `typeof t.$inferSelect` / `$inferInsert` keep working.
 */

type Kind = "text" | "num" | "int" | "bool" | "date" | "day" | "json" | "uuid";

export interface ColCfg {
  kind: Kind;
  notNull: boolean;
  def?: () => unknown;
  pk?: boolean;
  serial?: boolean;
  unique?: boolean;
}

export class Col<T, N extends boolean, D extends boolean> {
  declare readonly _t: T;
  declare readonly _n: N;
  declare readonly _d: D;
  constructor(readonly cfg: ColCfg) {}
  notNull(): Col<T, true, D> { return new Col({ ...this.cfg, notNull: true }); }
  /** Value, or a function called per row. Objects and arrays are cloned per row. */
  default(v: T | (() => T)): Col<T, N, true> {
    const f = typeof v === "function" ? (v as () => T) : () => (v !== null && typeof v === "object" ? structuredClone(v) : v);
    return new Col({ ...this.cfg, def: f });
  }
  defaultNow(): Col<T, N, true> { return new Col({ ...this.cfg, def: () => new Date() }); }
  defaultRandom(): Col<T, N, true> { return new Col({ ...this.cfg, def: () => crypto.randomUUID() }); }
  primaryKey(): Col<T, true, D> { return new Col({ ...this.cfg, notNull: true, pk: true }); }
  /** Single-column unique constraint (index name = column name). Nulls never collide. */
  unique(): Col<T, N, D> { return new Col({ ...this.cfg, unique: true }); }
  $type<U>(): Col<U, N, D> { return this as unknown as Col<U, N, D>; }
}

const col = <T>(kind: Kind) => new Col<T, false, false>({ kind, notNull: false });
export const text = () => col<string>("text");
export const uuid = () => col<string>("uuid");
/** double precision */
export const num = () => col<number>("num");
export const integer = () => col<number>("int");
export const boolean = () => col<boolean>("bool");
/** timestamptz, as a Date */
export const timestamp = () => col<Date>("date");
/** calendar date, as "YYYY-MM-DD" */
export const day = () => col<string>("day");
export const json = <T = unknown>() => col<T>("json");
/** bigserial primary key: filled from the table's sequence when omitted. */
export const serial = () => new Col<number, true, true>({ kind: "int", notNull: true, pk: true, serial: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCol = Col<any, boolean, boolean>;
export type Cols = Record<string, AnyCol>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type RowOf<C extends Cols> = Simplify<{ -readonly [K in keyof C]: C[K] extends Col<infer T, infer N, boolean> ? (N extends true ? T : T | null) : never }>;
type ReqKeys<C extends Cols> = { [K in keyof C]: C[K] extends Col<unknown, true, false> ? K : never }[keyof C];
export type InsertOf<C extends Cols> = Simplify<{ -readonly [K in ReqKeys<C>]: RowOf<C>[K] } & { -readonly [K in Exclude<keyof C, ReqKeys<C>>]?: RowOf<C>[K] | undefined }>;

export interface IndexSpec<R> {
  /** Equality fields: one sorted set per distinct value tuple. Empty = one set for the whole table. */
  on: readonly (keyof R & string)[];
  /** Score field (number or Date). Absent = score 0, i.e. pk order. Null values sort first (-inf). */
  sort?: keyof R & string;
  /** Partial index: rows for which this is false are left out. */
  when?: (r: R) => boolean;
}
export interface UniqueSpec<R> {
  on: readonly (keyof R & string)[];
  /** Partial unique: only rows for which this is true take part (like `unique ... where status = 'pending'`). */
  when?: (r: R) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpecs = Record<string, IndexSpec<any>>;

/** Specs are checked against the row type in `table()`; the stored def erases it (the `when` predicates would make defs invariant). */
export interface TableDef<N extends string = string, C extends Cols = Cols, IX extends AnySpecs = AnySpecs> {
  readonly name: N;
  readonly cols: C;
  readonly pk: readonly string[];
  readonly serial?: string;
  readonly indexes: IX;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly unique: Record<string, UniqueSpec<any>>;
  readonly $inferSelect: RowOf<C>;
  readonly $inferInsert: InsertOf<C>;
}

export type Row<T extends TableDef> = T["$inferSelect"];
export type Insert<T extends TableDef> = T["$inferInsert"];

export function table<
  const N extends string,
  const C extends Cols,
  const IX extends Record<string, IndexSpec<RowOf<C>>> = Record<never, IndexSpec<RowOf<C>>>,
>(name: N, cols: C, opts: { pk?: readonly (keyof C & string)[]; indexes?: IX & Record<string, IndexSpec<RowOf<C>>>; unique?: Record<string, UniqueSpec<RowOf<C>>> } = {}): TableDef<N, C, IX> {
  const pk = opts.pk ?? Object.keys(cols).filter((k) => cols[k]!.cfg.pk);
  if (!pk.length) throw new Error(`table ${name}: no primary key`);
  const unique: Record<string, UniqueSpec<RowOf<C>>> = { ...opts.unique };
  for (const [k, c] of Object.entries(cols)) if (c.cfg.unique) unique[k] = { on: [k as keyof RowOf<C> & string] };
  const serial = Object.keys(cols).find((k) => cols[k]!.cfg.serial);
  return { name, cols, pk, serial, indexes: (opts.indexes ?? {}) as IX, unique } as TableDef<N, C, IX>;
}

// ---- row encoding ----

const SEP = "\u001f";
/** Field value -> index/unique key part. Null and booleans get fixed tokens; Dates their epoch ms. */
export const part = (v: unknown): string =>
  v === null || v === undefined ? "\u0000" : v === true ? "1" : v === false ? "0" : v instanceof Date ? String(v.getTime()) : String(v);
export const joinParts = (vs: unknown[]) => vs.map(part).join(SEP);

export const pkOf = (t: TableDef, r: Record<string, unknown>) => joinParts(t.pk.map((k) => r[k]));
/** Caller-side pk: a scalar for one-column keys, a tuple (in `pk` order) for composite keys. */
export const pkArg = (t: TableDef, pk: unknown) => (Array.isArray(pk) ? joinParts(pk) : t.pk.length > 1 ? fail(`table ${t.name}: composite key needs a tuple`) : part(pk));

const fail = (m: string): never => { throw new Error(m); };

const toDate = (t: TableDef, k: string, v: unknown) => {
  const d = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : fail(`${t.name}.${k}: not a date`);
  if (Number.isNaN(d.getTime())) fail(`${t.name}.${k}: invalid date`);
  return d;
};

/** Insert values -> full row: defaults applied, every column present (null when unset), not-null enforced. */
export function normalize(t: TableDef, ins: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(ins)) if (!(k in t.cols)) fail(`${t.name}: unknown column ${k}`);
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(t.cols)) {
    let v = ins[k];
    if (v === undefined) v = c.cfg.def ? c.cfg.def() : null;
    if (v !== null && c.cfg.kind === "date") v = toDate(t, k, v);
    if (v === null && c.cfg.notNull && !c.cfg.serial) fail(`${t.name}.${k}: null value violates not-null`); // serial ids are filled from the sequence
    out[k] = v;
  }
  return out;
}

/** Patch applied over a row: undefined fields are left alone (like Drizzle's `set`). */
export function patchRow(t: TableDef, cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const c = t.cols[k] ?? fail(`${t.name}: unknown column ${k}`);
    if (v === null && c.cfg.notNull) fail(`${t.name}.${k}: null value violates not-null`);
    out[k] = v !== null && c.cfg.kind === "date" ? toDate(t, k, v) : v;
  }
  return out;
}

export function encode(t: TableDef, r: Record<string, unknown>): string {
  const o: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(t.cols)) {
    const v = r[k];
    if (v === null || v === undefined) o[k] = null;
    else if (c.cfg.kind === "date") o[k] = (v as Date).getTime();
    else if ((c.cfg.kind === "num" || c.cfg.kind === "int") && typeof v === "number" && !Number.isFinite(v)) o[k] = String(v); // JSON has no NaN/Infinity
    else o[k] = v;
  }
  return JSON.stringify(o);
}

export function decode(t: TableDef, json: string): Record<string, unknown> {
  const o = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(t.cols)) {
    const v = o[k];
    if (v === null || v === undefined) out[k] = c.cfg.def && c.cfg.notNull ? c.cfg.def() : null; // column added after the row was written
    else if (c.cfg.kind === "date") out[k] = new Date(v as number);
    else if ((c.cfg.kind === "num" || c.cfg.kind === "int") && typeof v === "string") out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

const scoreOf = (v: unknown) =>
  v === null || v === undefined ? -Infinity : v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : fail(`index sort value must be a number or date, got ${typeof v}`);

/** Index entries (key -> score) a row belongs to. Key = "<table>:<index>:<parts>". */
export function indexEntries(t: TableDef, r: Record<string, unknown>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [name, ix] of Object.entries(t.indexes)) {
    if (ix.when && !ix.when(r as never)) continue;
    m.set(`${t.name}:${name}:${joinParts(ix.on.map((k) => r[k]))}`, ix.sort ? scoreOf(r[ix.sort]) : 0);
  }
  return m;
}
export const indexKey = (t: TableDef, name: string, match: Record<string, unknown>) => {
  const ix = t.indexes[name] ?? fail(`table ${t.name}: no index ${name}`);
  for (const k of ix.on) if (!(k in match)) fail(`index ${t.name}.${name}: match is missing ${k}`);
  return `${t.name}:${name}:${joinParts(ix.on.map((k) => match[k]))}`;
};

/** Unique values a row holds (key -> value). Rows with a null in a unique column hold none for it. */
export function uniqueEntries(t: TableDef, r: Record<string, unknown>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, u] of Object.entries(t.unique)) {
    if (u.when && !u.when(r as never)) continue;
    const vs = u.on.map((k) => r[k]);
    if (vs.some((v) => v === null || v === undefined)) continue;
    m.set(`${t.name}:${name}`, joinParts(vs));
  }
  return m;
}
export const uniqueKey = (t: TableDef, name: string, match: Record<string, unknown>) => {
  const u = t.unique[name] ?? fail(`table ${t.name}: no unique ${name}`);
  return { k: `${t.name}:${name}`, v: joinParts(u.on.map((k) => match[k])) };
};

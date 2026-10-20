// Pure Filter edits behind the FilterPanel. The panel never holds its own state: edit Filter -> formatQuery -> bar text -> parseQuery -> Filter.
import { DSL_KEYS, parseQuery, type Filter } from "@pm/core";

export type RangeField =
  | "liquidity" | "volume24h" | "depth2c" | "spread" | "price" | "daysToResolution" | "stalenessHours"
  | "holderTop1Share" | "holderCount" | "priority" | "opportunity" | "edge";
export type FlagField = "watchlisted" | "pinned" | "muted" | "hasThesis";
export type ListField = "resolutionSource" | "structural";
export type TagKind = "tags" | "categories";

const KEY_OF = new Map(DSL_KEYS.map((k) => [k.field, k.key]));

/** One bound as typed: `2k`, `1.5M`, `0.06`, `6¢`, `5%`. "" clears (undefined); anything unparsable is null. Number syntax is core's own (`parseQuery`), `¢` is the only extra. */
export function parseBound(field: RangeField, text: string): number | undefined | null {
  const t = text.trim();
  if (!t) return undefined;
  const cents = /^(\d+\.?\d*|\.\d+)¢$/.exec(t);
  if (cents) return Number(`${cents[1]}e-2`);
  if (/[^\w.$%,+-]/.test(t)) return null;
  const r = parseQuery(`${KEY_OF.get(field)}:>=${t}`);
  return r.errors.length ? null : (r.filter[field]?.min ?? null);
}

/** Inverse for display: 1500000 -> `1.5m`, 0.06 -> `0.06`. */
export function fmtBound(v: number | undefined): string {
  if (v === undefined) return "";
  for (const [d, s] of [[1e9, "b"], [1e6, "m"], [1e3, "k"]] as const) {
    if (Math.abs(v) >= d) {
      const x: string = String(v / d);
      if (x.length <= 6 && !x.includes("e") && Number(x) * d === v) return x + s;
    }
  }
  const s = String(v);
  return s.includes("e") ? v.toFixed(10).replace(/0+$/, "") : s;
}

/** Set or clear one bound. Null when min would exceed max (the input shows invalid and nothing commits). */
export function setBound(f: Filter, field: RangeField, which: "min" | "max", v: number | undefined): Filter | null {
  const r = { ...f[field], [which]: v };
  if (v === undefined) delete r[which];
  if (r.min !== undefined && r.max !== undefined && r.min > r.max) return null;
  const out = { ...f };
  if (r.min === undefined && r.max === undefined) delete out[field];
  else out[field] = r;
  return out;
}

export type Tri = "any" | "yes" | "no";
export const triGet = (f: Filter, field: FlagField): Tri => (f[field] === undefined ? "any" : f[field] ? "yes" : "no");
export function triSet(f: Filter, field: FlagField, v: Tri): Filter {
  const out = { ...f };
  if (v === "any") delete out[field];
  else out[field] = v === "yes";
  return out;
}

export function toggleValue<F extends ListField>(f: Filter, field: F, v: NonNullable<Filter[F]>[number]): Filter {
  const cur = (f[field] ?? []) as string[];
  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  const out = { ...f } as Record<string, unknown>;
  if (next.length) out[field] = next;
  else delete out[field];
  return out as Filter;
}

const EXCL = { tags: "excludeTags", categories: "excludeCategories" } as const;
/** Add a chip; a leading `-` makes it an exclude chip. Blank, comma-bearing and duplicate input is ignored. */
export function addChip(f: Filter, kind: TagKind, raw: string): Filter {
  const exclude = raw.trim().startsWith("-");
  const v = raw.trim().replace(/^-/, "").trim();
  if (!v || v.includes(",")) return f;
  const field = exclude ? EXCL[kind] : kind;
  const cur = f[field] ?? [];
  if (cur.some((x) => x.toLowerCase() === v.toLowerCase())) return f;
  return { ...f, [field]: [...cur, v] };
}
export function removeChip(f: Filter, kind: TagKind, value: string, exclude: boolean): Filter {
  const field = exclude ? EXCL[kind] : kind;
  const next = (f[field] ?? []).filter((x) => x !== value);
  const out = { ...f } as Record<string, unknown>;
  if (next.length) out[field] = next;
  else delete out[field];
  return out as Filter;
}

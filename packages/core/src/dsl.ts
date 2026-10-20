// Screener filter DSL: `liq:5k..50k vol24h:<2k cat:politics,-sports src:official_data sort:-prio is:pinned`.
import { z } from "zod";

export const RangeSchema = z.object({ min: z.number().optional(), max: z.number().optional() });
export type Range = z.infer<typeof RangeSchema>;

const ResolutionSourceTypeSchema = z.enum(["official_data", "scheduled_event", "media_report", "subjective", "unknown"]);
const StructuralKindSchema = z.enum(["overround", "monotonicity_violation", "sibling_inconsistency"]);

/** Canonical sortable fields (Filter field names). */
export const SORT_FIELDS = [
  "priority", "opportunity", "edge", "liquidity", "volume24h", "depth2c", "spread", "price",
  "daysToResolution", "stalenessHours", "holderTop1Share", "holderCount",
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const FilterSchema = z.object({
  text: z.string().optional(), // fuzzy over question/rules
  tags: z.array(z.string()).optional(),
  excludeTags: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  excludeCategories: z.array(z.string()).optional(),
  liquidity: RangeSchema.optional(),
  volume24h: RangeSchema.optional(),
  depth2c: RangeSchema.optional(),
  spread: RangeSchema.optional(),
  price: RangeSchema.optional(), // YES mid
  daysToResolution: RangeSchema.optional(),
  stalenessHours: RangeSchema.optional(),
  holderTop1Share: RangeSchema.optional(),
  holderCount: RangeSchema.optional(),
  resolutionSource: z.array(ResolutionSourceTypeSchema).optional(),
  structural: z.array(StructuralKindSchema).optional(),
  priority: RangeSchema.optional(),
  opportunity: RangeSchema.optional(),
  edge: RangeSchema.optional(),
  watchlisted: z.boolean().optional(),
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
  hasThesis: z.boolean().optional(),
  sort: z.array(z.object({ field: z.enum(SORT_FIELDS), dir: z.enum(["asc", "desc"]) })).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
export type Filter = z.infer<typeof FilterSchema>;

export type DslError = { token: string; message: string; col?: number; suggestion?: string };
type Kind = "range" | "tags" | "src" | "struct" | "sort" | "is" | "has" | "int";
export type DslKey = { key: string; aliases: string[]; field: string; kind: Kind; description: string; example: string };

/** Key table for parser and UI hints. `key` is the short form; `field` the Filter field (sort fields use the same names). */
export const DSL_KEYS: readonly DslKey[] = [
  { key: "liq", aliases: ["liquidity"], field: "liquidity", kind: "range", description: "Liquidity in USDC", example: "liq:2k..75k" },
  { key: "vol24h", aliases: ["vol", "volume24h"], field: "volume24h", kind: "range", description: "24h volume in USDC", example: "vol24h:<2k" },
  { key: "depth", aliases: ["depth2c"], field: "depth2c", kind: "range", description: "USDC resting within 2c of mid", example: "depth:>1k" },
  { key: "spread", aliases: [], field: "spread", kind: "range", description: "Bid-ask spread (0..1)", example: "spread:<0.04" },
  { key: "price", aliases: [], field: "price", kind: "range", description: "YES mid band (0..1 or %)", example: "price:0.05..0.95" },
  { key: "days", aliases: ["daysToResolution"], field: "daysToResolution", kind: "range", description: "Days to resolution", example: "days:7..90" },
  { key: "stale", aliases: ["stalenessHours"], field: "stalenessHours", kind: "range", description: "Hours since last trade", example: "stale:>48" },
  { key: "top1", aliases: ["holderTop1Share"], field: "holderTop1Share", kind: "range", description: "Top holder share of supply (0..1)", example: "top1:>0.4" },
  { key: "holders", aliases: ["holderCount"], field: "holderCount", kind: "range", description: "Number of holders", example: "holders:<50" },
  { key: "tag", aliases: ["tags"], field: "tags", kind: "tags", description: "Tags, comma list; prefix - to exclude", example: "tag:politics,-sports" },
  { key: "cat", aliases: ["category"], field: "categories", kind: "tags", description: "Category, comma list; prefix - to exclude", example: "cat:politics,-sports" },
  { key: "src", aliases: ["resolutionSource"], field: "resolutionSource", kind: "src", description: "Resolution source type: official_data, scheduled_event, media_report, subjective, unknown (off/sch/med/sub/unk)", example: "src:official_data,scheduled_event" },
  { key: "struct", aliases: ["structural"], field: "structural", kind: "struct", description: "Structural mispricing: overround, monotonicity_violation, sibling_inconsistency (over/mono/sibling)", example: "struct:overround" },
  { key: "prio", aliases: ["priority"], field: "priority", kind: "range", description: "Screen priority score", example: "prio:>0.6" },
  { key: "opp", aliases: ["opportunity"], field: "opportunity", kind: "range", description: "Opportunity score O", example: "opp:>0.01" },
  { key: "edge", aliases: [], field: "edge", kind: "range", description: "Estimated edge (0..1 or %)", example: "edge:>3%" },
  { key: "sort", aliases: [], field: "sort", kind: "sort", description: "Sort fields, comma list; prefix - for descending", example: "sort:-prio,vol24h" },
  { key: "is", aliases: [], field: "watchlisted", kind: "is", description: "is:watch|pinned|muted (-is:x excludes)", example: "is:pinned" },
  { key: "has", aliases: [], field: "hasThesis", kind: "has", description: "has:thesis — only markets with a thesis (-has:thesis excludes)", example: "has:thesis" },
  { key: "limit", aliases: [], field: "limit", kind: "int", description: "Max rows (1..1000)", example: "limit:50" },
  { key: "offset", aliases: [], field: "offset", kind: "int", description: "Rows to skip", example: "offset:50" },
];

const IS_FIELDS = { watch: "watchlisted", pinned: "pinned", muted: "muted" } as const;
const HAS_FIELDS = { thesis: "hasThesis" } as const;
const IS_ALIASES: Record<string, string> = { watched: "watch", watchlist: "watch", watchlisted: "watch" };
const EXCLUDE_FIELD: Record<string, string> = { tags: "excludeTags", categories: "excludeCategories" };

const KEY_LOOKUP = new Map<string, DslKey>();
for (const k of DSL_KEYS) for (const n of [k.key, ...k.aliases, k.field]) KEY_LOOKUP.set(n.toLowerCase(), k);
const ALL_KEY_NAMES = DSL_KEYS.flatMap((k) => [k.key, ...k.aliases]);

/** Alias or canonical sort field name → canonical, or null. (`mid` is an alias of `price`.) */
export function canonicalSortField(name: string): SortField | null {
  const l = name.toLowerCase();
  if (l === "mid") return "price";
  const k = KEY_LOOKUP.get(l);
  return k && (SORT_FIELDS as readonly string[]).includes(k.field) ? (k.field as SortField) : null;
}
const SHORT_BY_FIELD = new Map(DSL_KEYS.map((k) => [k.field, k.key]));

const SRC_ALIASES: Record<string, string> = {
  off: "official_data", official: "official_data", sch: "scheduled_event", scheduled: "scheduled_event",
  med: "media_report", media: "media_report", sub: "subjective", unk: "unknown",
};
const STRUCT_ALIASES: Record<string, string> = {
  mono: "monotonicity_violation", monotonicity: "monotonicity_violation", sibling: "sibling_inconsistency", over: "overround",
};

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
function nearest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const o of options) {
    const d = lev(word.toLowerCase(), o.toLowerCase());
    if (d < bd) (bd = d), (best = o);
  }
  return best !== undefined && bd <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

const NUM = /^([-+]?(?:\d+\.?\d*|\.\d+))([kmb%]?)$/i;
const EXP: Record<string, number> = { "": 0, k: 3, m: 6, b: 9, "%": -2 };
/** Parse `5k`, `1.2m`, `0.04`, `5%`, `$2k`. Exponent applied textually so decimal results are exact (1.1m = 1100000). */
function parseNum(s: string): number | null {
  const m = NUM.exec(s.replace(/^\$/, "").replace(/,/g, ""));
  if (!m) return null;
  const v = Number(`${m[1]}e${EXP[m[2]!.toLowerCase()]}`);
  return Number.isFinite(v) ? v : null;
}

function parseRange(v: string): Range | string {
  const bound = (s: string) => {
    const n = parseNum(s);
    return n === null ? `invalid number "${s}"` : n;
  };
  let r: Range;
  const dd = v.split("..");
  if (dd.length > 2) return "too many '..' in range";
  if (dd.length === 2) {
    if (dd[0] === "" && dd[1] === "") return "empty range";
    r = {};
    if (dd[0] !== "") { const a = bound(dd[0]!); if (typeof a === "string") return a; r.min = a; }
    if (dd[1] !== "") { const b = bound(dd[1]!); if (typeof b === "string") return b; r.max = b; }
    if (r.min !== undefined && r.max !== undefined && r.min > r.max) return "range min exceeds max";
    return r;
  }
  const op = /^(<=|>=|<|>)(.*)$/.exec(v);
  if (op) {
    const n = bound(op[2]!);
    if (typeof n === "string") return n;
    return op[1]![0] === "<" ? { max: n } : { min: n };
  }
  const n = bound(v);
  return typeof n === "string" ? n : { min: n, max: n };
}

function tokenize(q: string): { text: string; col: number }[] {
  const out: { text: string; col: number }[] = [];
  const re = /(?:[^\s"]|"[^"]*"?)+/g; // a token may contain quoted segments: tag:"a b"
  for (let m = re.exec(q); m; m = re.exec(q)) out.push({ text: m[0], col: m.index });
  return out;
}

const addUnique = (arr: string[] | undefined, items: string[]) => {
  const out = arr ?? [];
  for (const i of items) if (!out.includes(i)) out.push(i);
  return out;
};

/** Parse a query string. Never throws; invalid tokens are reported in `errors` and skipped. */
export function parseQuery(q: string): { filter: Filter; errors: DslError[] } {
  const filter: Record<string, unknown> = {};
  const errors: DslError[] = [];
  const words: string[] = [];
  for (const { text: token, col } of tokenize(q ?? "")) {
    const err = (message: string, suggestion?: string) =>
      errors.push({ token, message, col, ...(suggestion ? { suggestion } : {}) });
    let t = token;
    let negate = false;
    const neg = /^-((?:is|has):.*)$/i.exec(t);
    if (neg) { negate = true; t = neg[1]!; }
    const negKey = !negate ? /^-([A-Za-z][A-Za-z0-9]*):/.exec(t) : null;
    if (negKey && KEY_LOOKUP.has(negKey[1]!.toLowerCase())) {
      err(`"-" prefix is only valid for is:/has: (use ${negKey[1]!.toLowerCase() === "tag" ? "tag:-value" : "a range such as <x"} instead)`);
      continue;
    }
    const ci = t.indexOf(":");
    const keyPart = ci > 0 ? t.slice(0, ci) : "";
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(keyPart)) {
      words.push(token.replace(/"/g, ""));
      continue;
    }
    const def = KEY_LOOKUP.get(keyPart.toLowerCase());
    const value = t.slice(ci + 1).replace(/"/g, "");
    if (!def) { err(`unknown key "${keyPart}"`, nearest(keyPart, ALL_KEY_NAMES)); continue; }
    if (negate && def.kind !== "is" && def.kind !== "has") { err(`"-" prefix is only valid for is:/has:`); continue; }
    if (value === "") { err(`missing value for "${def.key}"`); continue; }
    const items = value.split(",").filter((s) => s !== "");
    switch (def.kind) {
      case "range": {
        const r = parseRange(value);
        if (typeof r === "string") { err(r); break; }
        const merged: Range = { ...(filter[def.field] as Range | undefined), ...r };
        if (merged.min !== undefined && merged.max !== undefined && merged.min > merged.max) { err(`range min exceeds max after merging with earlier ${def.key}:`); break; }
        filter[def.field] = merged;
        break;
      }
      case "tags": {
        const inc = items.filter((s) => !s.startsWith("-") && s !== "");
        const exc = items.filter((s) => s.startsWith("-") && s.length > 1).map((s) => s.slice(1));
        if (!inc.length && !exc.length) { err(`no ${def.key} values given`); break; }
        const ex = EXCLUDE_FIELD[def.field]!;
        if (inc.length) filter[def.field] = addUnique(filter[def.field] as string[] | undefined, inc);
        if (exc.length) filter[ex] = addUnique(filter[ex] as string[] | undefined, exc);
        break;
      }
      case "src":
      case "struct": {
        const vals: string[] = [];
        let bad = false;
        for (const raw of items) {
          const l = raw.toLowerCase();
          const v = def.kind === "src" ? (SRC_ALIASES[l] ?? l) : (STRUCT_ALIASES[l] ?? l);
          const schema = def.kind === "src" ? ResolutionSourceTypeSchema : StructuralKindSchema;
          if (!schema.safeParse(v).success) {
            err(`invalid ${def.key} value "${raw}"`, nearest(l, [...schema.options, ...Object.keys(def.kind === "src" ? SRC_ALIASES : STRUCT_ALIASES)]));
            bad = true;
            break;
          }
          vals.push(v);
        }
        if (!bad) filter[def.field] = addUnique(filter[def.field] as string[] | undefined, vals);
        break;
      }
      case "sort": {
        const specs: { field: string; dir: "asc" | "desc" }[] = [];
        let bad = false;
        for (const raw of items) {
          const dir = raw.startsWith("-") ? "desc" : "asc";
          const name = raw.replace(/^[-+]/, "");
          const field = canonicalSortField(name);
          if (!field) { err(`unknown sort field "${name}"`, nearest(name, [...SORT_FIELDS, ...DSL_KEYS.filter((k) => canonicalSortField(k.key)).map((k) => k.key)])); bad = true; break; }
          specs.push({ field, dir });
        }
        if (!bad) filter.sort = [...((filter.sort as unknown[] | undefined) ?? []), ...specs];
        break;
      }
      case "is": {
        const v = value.toLowerCase();
        const k = (IS_ALIASES[v] ?? v) as keyof typeof IS_FIELDS;
        if (k in IS_FIELDS) filter[IS_FIELDS[k]] = !negate;
        else err(`unknown is: value "${value}" (try ${Object.keys(IS_FIELDS).join("|")})`, nearest(v, Object.keys(IS_FIELDS)));
        break;
      }
      case "has": {
        const v = value.toLowerCase();
        if (v in HAS_FIELDS) filter[HAS_FIELDS[v as keyof typeof HAS_FIELDS]] = !negate;
        else err(`unknown has: value "${value}" (try ${Object.keys(HAS_FIELDS).join("|")})`, nearest(v, Object.keys(HAS_FIELDS)));
        break;
      }
      case "int": {
        const n = Number(value);
        const min = def.field === "limit" ? 1 : 0;
        if (!/^\d+$/.test(value) || n < min || (def.field === "limit" && n > 1000)) err(`${def.key} must be an integer${def.field === "limit" ? " 1..1000" : " ≥ 0"}`);
        else filter[def.field] = n;
        break;
      }
    }
  }
  if (words.length) filter.text = words.join(" ");
  return { filter: filter as Filter, errors };
}

/** Plain decimal text for v (never exponent notation: parseNum doesn't accept it). Exact digits of String(v) are preserved. */
function plain(v: number): string {
  const s = String(v);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2]! + (m[3] ?? ""), e = Number(m[4]);
  const body = e < 0 ? `0.${"0".repeat(-e - 1)}${digits}` : digits.length - 1 <= e ? digits + "0".repeat(e - (digits.length - 1)) : `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  return m[1] + body;
}
function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) {
    for (const [div, suf] of [[1e6, "m"], [1e3, "k"]] as const) {
      if (Math.abs(v) >= div) {
        const s = String(v / div);
        if (!s.includes("e") && Number(`${s}e${suf === "m" ? 6 : 3}`) === v) return s + suf;
      }
    }
  }
  return plain(v);
}
const fmtRange = (r: Range): string | null => {
  if (r.min !== undefined && r.max !== undefined) return `${fmtNum(r.min)}..${fmtNum(r.max)}`;
  if (r.min !== undefined) return `>=${fmtNum(r.min)}`;
  if (r.max !== undefined) return `<=${fmtNum(r.max)}`;
  return null;
};

/** Inverse of parseQuery for valid filters: `parseQuery(formatQuery(f)).filter` deep-equals `f`. */
export function formatQuery(f: Filter): string {
  const parts: string[] = [];
  for (const d of DSL_KEYS) {
    const v = (f as Record<string, unknown>)[d.field];
    if (v === undefined && d.kind !== "tags" && d.kind !== "is" && d.kind !== "has") continue;
    switch (d.kind) {
      case "range": { const r = fmtRange(v as Range); if (r) parts.push(`${d.key}:${r}`); break; }
      case "tags": {
        const all = [...((v as string[] | undefined) ?? []), ...((f as Record<string, string[] | undefined>)[EXCLUDE_FIELD[d.field]!] ?? []).map((s) => `-${s}`)];
        if (all.length) parts.push(`${d.key}:${all.join(",")}`);
        break;
      }
      case "src":
      case "struct": if ((v as string[]).length) parts.push(`${d.key}:${(v as string[]).join(",")}`); break;
      case "sort": if ((v as unknown[]).length) parts.push(`sort:${(f.sort ?? []).map((s) => `${s.dir === "desc" ? "-" : ""}${SHORT_BY_FIELD.get(s.field) ?? s.field}`).join(",")}`); break;
      case "is": case "has":
        for (const [name, field] of Object.entries(d.kind === "is" ? IS_FIELDS : HAS_FIELDS)) {
          const b = (f as Record<string, unknown>)[field];
          if (b !== undefined) parts.push(`${b ? "" : "-"}${d.key}:${name}`);
        }
        break;
      case "int": parts.push(`${d.key}:${v}`); break;
    }
  }
  if (f.text) parts.push(/(^|\s)-?[A-Za-z][A-Za-z0-9]*:/.test(f.text) ? `"${f.text}"` : f.text);
  return parts.filter(Boolean).join(" ");
}

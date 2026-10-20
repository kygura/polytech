// Pure helpers for the screener query bar (DESIGN 12.2): token classing, hints, suggestion fix, sort rewrite, paging, default query.
import { DSL_KEYS, parseQuery, type DslError, type DslKey } from "@pm/core";
import type { SortSpec } from "./types";

export const PAGE = 200;

const NAMES = new Map<string, DslKey>();
for (const k of DSL_KEYS) for (const n of [k.key, ...k.aliases, k.field]) NAMES.set(n.toLowerCase(), k);
export const keyDef = (name: string) => NAMES.get(name.toLowerCase());

/** Same token rule as core's parser (quoted segments stay inside a token). */
export function tokenize(q: string): { text: string; col: number }[] {
  const out: { text: string; col: number }[] = [];
  const re = /(?:[^\s"]|"[^"]*"?)+/g;
  for (let m = re.exec(q); m; m = re.exec(q)) out.push({ text: m[0], col: m.index });
  return out;
}

// ---- highlighting ----
export type Cls = "key" | "op" | "val" | "neg" | "word" | "ws";
export type Seg = { text: string; cls: Cls; err: boolean };

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function classifyToken(t: string, err: boolean, out: Seg[]) {
  const push = (text: string, cls: Cls) => text && out.push({ text, cls, err });
  let rest = t;
  const neg = /^-([A-Za-z][A-Za-z0-9]*):/.exec(t);
  if (neg && keyDef(neg[1]!)) { push("-", "neg"); rest = t.slice(1); }
  const ci = rest.indexOf(":");
  const keyPart = ci > 0 ? rest.slice(0, ci) : "";
  if (!KEY_RE.test(keyPart)) return push(rest, "word");
  const def = keyDef(keyPart);
  push(keyPart, def ? "key" : "word");
  push(":", "op");
  const dash = def?.kind === "tags" || def?.kind === "sort";
  for (const piece of rest.slice(ci + 1).split(/(<=|>=|<|>|\.\.|,)/)) {
    if (/^(<=|>=|<|>|\.\.|,)$/.test(piece)) push(piece, "op");
    else if (dash && piece.startsWith("-")) { push("-", "neg"); push(piece.slice(1), "val"); }
    else push(piece, "val");
  }
}

/** Mirror segments for `DslHighlighter`. Concatenated `text` always equals the input. `err` covers the whole token a parse error points at. */
export function classify(text: string, errors: Pick<DslError, "col">[]): Seg[] {
  const out: Seg[] = [];
  const bad = new Set(errors.map((e) => e.col));
  let pos = 0;
  for (const tk of tokenize(text)) {
    if (tk.col > pos) out.push({ text: text.slice(pos, tk.col), cls: "ws", err: false });
    classifyToken(tk.text, bad.has(tk.col), out);
    pos = tk.col + tk.text.length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), cls: "ws", err: false });
  return out;
}

// ---- hints ----
export type Hint = { label: string; insert: string; kind: "key" | "value"; example?: string; description?: string };
export type HintCtx = { from: number; to: number; prefix: string; mode: "key" | "value"; key?: DslKey; colonAfter: boolean };

const VALUES: Record<string, string[]> = {
  src: ["official_data", "scheduled_event", "media_report", "subjective", "unknown"],
  struct: ["overround", "monotonicity_violation", "sibling_inconsistency"],
  is: ["watch", "pinned", "muted"],
  has: ["thesis"],
};

/** Where the caret sits in the query: a key prefix or a value segment, with the span an accepted hint replaces. */
export function hintContext(text: string, caret: number): HintCtx | null {
  const tk = tokenize(text).find((t) => t.col <= caret && caret <= t.col + t.text.length);
  if (!tk) return null;
  const t = tk.text, rel = caret - tk.col, off = t.startsWith("-") ? 1 : 0, ci = t.indexOf(":");
  if (ci === -1 || rel <= ci) {
    if (rel <= off || t.includes('"')) return null;
    return { from: tk.col + off, to: tk.col + (ci === -1 ? t.length : ci), prefix: t.slice(off, rel).toLowerCase(), mode: "key", colonAfter: ci !== -1 };
  }
  const key = keyDef(t.slice(off, ci));
  if (!key) return null;
  const segStart = ci + 1 + t.slice(ci + 1, rel).lastIndexOf(",") + 1;
  const next = t.indexOf(",", rel);
  const dash = t[segStart] === "-" ? 1 : 0;
  return { from: tk.col + segStart + dash, to: tk.col + (next === -1 ? t.length : next), prefix: t.slice(segStart + dash, rel).replace(/"/g, "").toLowerCase(), mode: "value", key, colonAfter: false };
}

/** `known` = tag / category values seen in the loaded rows. */
export function hintItems(ctx: HintCtx | null, known: { tags: string[]; categories: string[] }, max = 8): Hint[] {
  if (!ctx) return [];
  if (ctx.mode === "key") {
    return DSL_KEYS.filter((k) => [k.key, ...k.aliases].some((n) => n.toLowerCase().startsWith(ctx.prefix)))
      .slice(0, max).map((k) => ({ label: k.key, insert: k.key, kind: "key" as const, example: k.example, description: k.description }));
  }
  const k = ctx.key!;
  const pool = k.kind === "tags" ? (k.key === "cat" ? known.categories : known.tags) : k.kind === "src" || k.kind === "struct" || k.kind === "is" || k.kind === "has" ? (VALUES[k.key] ?? []) : [];
  return pool.filter((v) => v.toLowerCase().startsWith(ctx.prefix) && v.toLowerCase() !== ctx.prefix && !v.includes(","))
    .slice(0, max).map((v) => ({ label: v, insert: /\s/.test(v) ? `"${v}"` : v, kind: "value" as const }));
}

/** Insert a hint: keys become `key:` (colon reused when one follows), values replace the segment. Returns the new text and caret. */
export function acceptHint(text: string, ctx: HintCtx, h: Hint): { text: string; caret: number } {
  const ins = h.kind === "key" && !ctx.colonAfter ? `${h.insert}:` : h.insert;
  const caret = ctx.from + ins.length + (h.kind === "key" && ctx.colonAfter ? 1 : 0);
  return { text: text.slice(0, ctx.from) + ins + text.slice(ctx.to), caret };
}

// ---- suggestion chip ----
/** The first parse error whose token spans the caret. */
export function errorAt(errors: DslError[], caret: number): DslError | undefined {
  return errors.find((e) => e.col != null && e.col <= caret && caret <= e.col + e.token.length);
}

/** Replace the quoted offender in the message (bad key or bad value) with `error.suggestion`. */
export function applySuggestion(text: string, e: DslError): { text: string; caret: number } | null {
  if (!e.suggestion || e.col == null || text.slice(e.col, e.col + e.token.length) !== e.token) return null;
  const bad = /"([^"]*)"/.exec(e.message)?.[1];
  const at = bad ? e.token.indexOf(bad) : -1;
  if (!bad || at < 0) return null;
  const from = e.col + at;
  return { text: text.slice(0, from) + e.suggestion + text.slice(from + bad.length), caret: from + e.suggestion.length };
}

// ---- sort in the query ----
const SHORT = new Map(DSL_KEYS.map((k) => [k.field, k.key]));
export const DEFAULT_SORT: SortSpec[] = [{ field: "priority", dir: "desc" }];

/** Replace every `sort:` token with one for `sorts` (the rest of the text keeps its order). */
export function setSortInQuery(text: string, sorts: SortSpec[]): string {
  const kept = tokenize(text).map((t) => t.text).filter((t) => !/^sort:/i.test(t));
  if (sorts.length) kept.push(`sort:${sorts.map((s) => `${s.dir === "desc" ? "-" : ""}${SHORT.get(s.field) ?? s.field}`).join(",")}`);
  return kept.join(" ");
}

/** Header click: replace the sort; shift-click: flip the field if present, else append as a secondary key. */
export function nextSorts(current: SortSpec[], next: SortSpec, additive: boolean): SortSpec[] {
  if (!additive) return [next];
  const base = current.length ? current : DEFAULT_SORT;
  return base.some((s) => s.field === next.field)
    ? base.map((s) => (s.field === next.field ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s))
    : [...base, next];
}

// ---- paging & defaults ----
/** Page query for infinite scroll: `limit:200 offset:N` appended. A query with its own limit/offset is taken as written (`paged: false`). */
export function pagedQuery(q: string, offset = 0): { q: string; paged: boolean } {
  const { filter } = parseQuery(q);
  if (filter.limit != null || filter.offset != null) return { q, paged: false };
  return { q: `${q} limit:${PAGE}${offset ? ` offset:${offset}` : ""}`.trim(), paged: true };
}

/** DESIGN 12.2 ViewMenu: `Default` is built from Settings → Filters. */
export const defaultQuery = (f: { minDays: number; maxDays: number; minDepthUsd: number }) => `days:${f.minDays}..${f.maxDays} depth:>${f.minDepthUsd} sort:-prio`;

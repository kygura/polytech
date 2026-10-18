import { DEFAULT_STEERING, type ProfileFilter, type ResearchProfile, type Steering } from "@pm/core";

/** Pure form helpers for the research UI: draft <-> API body, steering overrides, zod issue -> field errors. */

export type Profile = Omit<ResearchProfile, "lastRunAt" | "createdAt" | "updatedAt"> & { lastRunAt: number | null; updatedAt: number };
/** API JSON (ISO strings) or RSC props (Date) -> epoch-ms profile. */
export const toProfile = (p: Omit<ResearchProfile, "lastRunAt" | "createdAt" | "updatedAt"> & { lastRunAt: Date | string | null; updatedAt: Date | string }): Profile => ({
  ...p, lastRunAt: p.lastRunAt == null ? null : new Date(p.lastRunAt).getTime(), updatedAt: new Date(p.updatedAt).getTime(),
});

export const UNITS = { min: 1, h: 60, d: 1440 } as const;
export type Unit = keyof typeof UNITS;

/** Blank number input = undefined (never 0). List fields stay raw text so typing a trailing comma works. */
export type FilterDraft = {
  categories: string[]; tags: string; textQuery: string;
  minVol24h: number | undefined; minDepthUsd: number | undefined; maxSpread: number | undefined;
  endsMin: number | undefined; endsMax: number | undefined; minAbsEdge: number | undefined; skipHours: number | undefined;
  sort: ProfileFilter["sort"]; limit: number | undefined; include: string; exclude: string;
};
export type Draft = { name: string; enabled: boolean; filter: FilterDraft; steering: Steering; every: number | undefined; unit: Unit };

export const parseTags = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
export const parseIds = (s: string) => s.split(/[\s,]+/).filter(Boolean);

const emptyFilter = (): FilterDraft => ({
  categories: [], tags: "", textQuery: "", minVol24h: undefined, minDepthUsd: undefined, maxSpread: undefined, endsMin: undefined, endsMax: undefined,
  minAbsEdge: undefined, skipHours: undefined, sort: "priority", limit: undefined, include: "", exclude: "",
});
export const newDraft = (): Draft => ({ name: "", enabled: false, filter: emptyFilter(), steering: structuredClone(DEFAULT_STEERING), every: undefined, unit: "h" });

export function fromFilter(f: ProfileFilter): FilterDraft {
  return {
    categories: f.categories ?? [], tags: (f.tagsAny ?? []).join(", "), textQuery: f.textQuery ?? "",
    minVol24h: f.minVol24h, minDepthUsd: f.minDepthUsd, maxSpread: f.maxSpread, endsMin: f.endsWithinDays?.min, endsMax: f.endsWithinDays?.max,
    minAbsEdge: f.minAbsEdge, skipHours: f.skipIfResearchedWithinHours, sort: f.sort, limit: f.limit,
    include: (f.includeConditionIds ?? []).join("\n"), exclude: (f.excludeConditionIds ?? []).join("\n"),
  };
}

/** Unset fields are omitted so the server defaults (skip 24h, limit 10, sort priority) apply. */
export function toFilter(d: FilterDraft): Partial<ProfileFilter> {
  const tags = parseTags(d.tags), inc = parseIds(d.include), exc = parseIds(d.exclude);
  const o: Partial<ProfileFilter> = { sort: d.sort };
  if (d.categories.length) o.categories = d.categories;
  if (tags.length) o.tagsAny = tags;
  if (d.textQuery.trim()) o.textQuery = d.textQuery.trim();
  if (d.minVol24h != null) o.minVol24h = d.minVol24h;
  if (d.minDepthUsd != null) o.minDepthUsd = d.minDepthUsd;
  if (d.maxSpread != null) o.maxSpread = d.maxSpread;
  if (d.endsMin != null || d.endsMax != null) o.endsWithinDays = { ...(d.endsMin != null && { min: d.endsMin }), ...(d.endsMax != null && { max: d.endsMax }) };
  if (d.minAbsEdge != null) o.minAbsEdge = d.minAbsEdge;
  if (d.skipHours != null) o.skipIfResearchedWithinHours = d.skipHours;
  if (d.limit != null) o.limit = d.limit;
  if (inc.length) o.includeConditionIds = inc;
  if (exc.length) o.excludeConditionIds = exc;
  return o;
}

export function fromProfile(p: Profile): Draft {
  const m = p.everyMin, unit: Unit = m == null ? "h" : m % 1440 === 0 ? "d" : m % 60 === 0 ? "h" : "min";
  return { name: p.name, enabled: p.enabled, filter: fromFilter(p.filter), steering: structuredClone(p.steering), every: m == null ? undefined : m / UNITS[unit], unit };
}

/** Drops models of deselected roles and empty optionals. */
export function cleanSteering(s: Steering): Steering {
  const keep = new Set<string>([...s.roles, ...s.customRoles.map((r) => r.key), "judge"]);
  const q = s.question?.trim();
  return {
    roles: s.roles, customRoles: s.customRoles, models: Object.fromEntries(Object.entries(s.models).filter(([k, v]) => keep.has(k) && v)),
    ...(q && { question: q }), ...(s.maxCostUsd != null && { maxCostUsd: s.maxCostUsd }),
    ...(s.exaCallCap != null && { exaCallCap: s.exaCallCap }), ...(s.maxTurns != null && { maxTurns: s.maxTurns }),
  };
}

/** Body for POST/PUT /api/research/profiles. */
export const buildInput = (d: Draft) => ({
  name: d.name.trim(), enabled: d.enabled, filter: toFilter(d.filter), steering: cleanSteering(d.steering),
  everyMin: d.every == null || !Number.isFinite(d.every) ? null : Math.max(1, Math.round(d.every * UNITS[d.unit])),
});

/** Cheap client pre-checks only; the server stays the validator. Returns the reason Save is blocked. */
export function blocker(d: Draft): string | null {
  const s = d.steering;
  if (!d.name.trim()) return "name required";
  if ((s.question?.length ?? 0) > 2000) return "question too long";
  if (s.roles.length < 1) return "pick at least one built-in role";
  if (s.roles.length + s.customRoles.length > 10) return "at most 10 roles";
  return null;
}

/**
 * Fields of `cur` that differ from `base`, for POST /api/markets/:id/research (server shallow-merges over the profile steering).
 * A cleared question is sent as "" so it overrides the profile's. ponytail: a cleared maxCostUsd/exaCallCap/maxTurns cannot be sent (the API has no "unset").
 */
export function steeringDiff(base: Steering, cur: Steering): Partial<Steering> {
  const a = cleanSteering(base), b = cleanSteering(cur), out: Record<string, unknown> = {};
  for (const k of ["question", "roles", "customRoles", "models", "maxCostUsd", "exaCallCap", "maxTurns"] as const) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    if (b[k] !== undefined) out[k] = b[k];
    else if (k === "question") out[k] = "";
  }
  return out as Partial<Steering>;
}

/** zod issues -> `{ "filter.limit": msg }` (first issue per dotted path; "" = no path). */
export function mapIssues(issues: { path: (string | number)[]; message: string }[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const i of issues) o[i.path.join(".")] ??= i.message;
  return o;
}
/** Sub-map under `prefix`, prefix stripped. */
export const scope = (errors: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));


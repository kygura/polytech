import { ProfileFilterSchema, SteeringSchema, type ProfileFilter, type ProfileInput, type ResearchProfile } from "@pm/core";
import { UniqueViolation, schema as s, type Db } from "@pm/db";
import { DAY } from "./deps";
import { latestScreens, latestSnaps } from "./screen";

type ThesisRow = typeof s.theses.$inferSelect;
const newestFirst = (a: ThesisRow, b: ThesisRow) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Newest thesis per market (the old `order by createdAt desc`, first row per conditionId), markets ordered by that thesis, newest first. */
export async function latestTheses(db: Db): Promise<Map<string, ThesisRow>> {
  const conds = (await db.theses.distinct("cond")).filter((c): c is string => c !== null);
  const rows = (await db.theses.findEach("cond", conds.map((conditionId) => ({ conditionId })), { order: "desc", limit: 1 })).flatMap((l) => l.slice(0, 1));
  return new Map(rows.sort(newestFirst).map((t) => [t.conditionId, t]));
}

export type Match = { conditionId: string; question: string; vol24h: number | null; spread: number | null; endDate: Date | null; edgeC: number | null };

/** Active markets passing every filter predicate (AND), sorted and limited. `now` is epoch ms. */
export async function matchMarkets(db: Db, f: ProfileFilter, now: number): Promise<Match[]> {
  const [markets, snaps, screens, ths, pods] = await Promise.all([
    db.markets.find("status", { status: "active" }),
    latestSnaps(db),
    latestScreens(db),
    latestTheses(db),
    f.skipIfResearchedWithinHours > 0 ? db.pods.find("byStarted", {}, { min: now - f.skipIfResearchedWithinHours * 3_600_000 }) : [],
  ]);
  const prio = new Map(screens.map((r) => [r.conditionId, r.priority]));
  const edge = new Map([...ths].map(([c, t]) => [c, t.edgeC])); // newest thesis per market
  const recent = new Set<string>();
  for (const p of pods) if (p.status !== "failed") recent.add(p.conditionId); // a failed pod produced nothing, so it doesn't block a retry

  const lc = (x: string) => x.toLowerCase();
  const cats = f.categories?.map(lc), tags = f.tagsAny?.map(lc), q = f.textQuery && lc(f.textQuery);
  const inc = f.includeConditionIds?.length ? new Set(f.includeConditionIds) : null, exc = new Set(f.excludeConditionIds);
  const rows = markets.flatMap((m) => {
    const sn = snaps.get(m.conditionId), e = edge.get(m.conditionId) ?? null;
    const vol = m.vol24h ?? sn?.vol24h ?? null;
    const spread = sn?.bestBid != null && sn.bestAsk != null ? sn.bestAsk - sn.bestBid : null;
    const days = m.endDate ? (m.endDate.getTime() - now) / DAY : null;
    const ok =
      (!inc || inc.has(m.conditionId)) && !exc.has(m.conditionId) && !recent.has(m.conditionId) &&
      (!cats || (m.category != null && cats.includes(lc(m.category)))) &&
      (!tags || m.tags.some((t) => tags.includes(lc(t)))) &&
      (!q || lc(m.question).includes(q)) &&
      (f.minVol24h == null || (vol != null && vol >= f.minVol24h)) &&
      (f.minDepthUsd == null || (sn?.depth5cUsd != null && sn.depth5cUsd >= f.minDepthUsd)) &&
      (f.maxSpread == null || (spread != null && spread <= f.maxSpread)) &&
      (f.endsWithinDays == null || ((f.endsWithinDays.min == null || (days != null && days >= f.endsWithinDays.min)) && (f.endsWithinDays.max == null || (days != null && days <= f.endsWithinDays.max)))) &&
      (f.minAbsEdge == null || (e != null && Math.abs(e) >= f.minAbsEdge));
    return ok ? [{ conditionId: m.conditionId, question: m.question, vol24h: vol, spread, endDate: m.endDate, edgeC: e }] : [];
  });

  const key = (r: Match): number | null =>
    f.sort === "vol24h" ? r.vol24h : f.sort === "edge" ? (r.edgeC == null ? null : Math.abs(r.edgeC)) : f.sort === "endDate" ? (r.endDate ? -r.endDate.getTime() : null) : prio.get(r.conditionId) ?? null;
  // every sort is "bigger key first"; endDate negated so earliest first. Missing keys last.
  rows.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || a.conditionId.localeCompare(b.conditionId));
  return rows.slice(0, f.limit);
}

// ---------------------------------------------------------------- repo
const toProfile = (r: typeof s.researchProfiles.$inferSelect): ResearchProfile => ({
  id: r.id, name: r.name, enabled: r.enabled, everyMin: r.everyMin, lastRunAt: r.lastRunAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  filter: ProfileFilterSchema.parse(r.filter), steering: SteeringSchema.parse(r.steering),
});

/** By name, in code-point order (Postgres `order by name` under the C collation). */
export const listProfiles = async (db: Db) =>
  (await db.researchProfiles.all()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(toProfile);
export const getProfile = async (db: Db, id: string) => {
  const r = await db.researchProfiles.get(id);
  return r ? toProfile(r) : null;
};
const nameTaken = async (db: Db, name: string, exceptId?: string) => {
  const r = await db.researchProfiles.byUnique("name", { name });
  return !!r && r.id !== exceptId;
};
/** Only the input's own columns (the old insert/set ignored anything else). */
const cols = (p: ProfileInput) => ({ name: p.name, enabled: p.enabled, filter: p.filter, steering: p.steering, everyMin: p.everyMin });
/** A unique-name race lost at commit reads as the same "name_taken" as the pre-check. */
const takenOnRace = (e: unknown): "name_taken" => { if (e instanceof UniqueViolation) return "name_taken"; throw e; };

/** `"name_taken"` instead of a profile when the unique name is in use. */
export async function createProfile(db: Db, p: ProfileInput): Promise<ResearchProfile | "name_taken"> {
  if (await nameTaken(db, p.name)) return "name_taken";
  try {
    return toProfile(await db.researchProfiles.insert({ ...cols(p), id: crypto.randomUUID() }));
  } catch (e) {
    return takenOnRace(e);
  }
}
/** Full replace; null = no such profile. */
export async function updateProfile(db: Db, id: string, p: ProfileInput): Promise<ResearchProfile | "name_taken" | null> {
  if (!(await getProfile(db, id))) return null;
  if (await nameTaken(db, p.name, id)) return "name_taken";
  try {
    const r = await db.researchProfiles.update(id, { ...cols(p), updatedAt: new Date() });
    return r ? toProfile(r) : null; // deleted in between
  } catch (e) {
    return takenOnRace(e);
  }
}
export const deleteProfile = async (db: Db, id: string) => (await db.researchProfiles.delete(id)) !== null;

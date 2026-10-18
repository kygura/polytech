import { ProfileFilterSchema, SteeringSchema, type ProfileFilter, type ProfileInput, type ResearchProfile } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { desc, eq, gte } from "drizzle-orm";
import { DAY } from "./deps";
import { latestScreens, latestSnaps } from "./screen";

export type Match = { conditionId: string; question: string; vol24h: number | null; spread: number | null; endDate: Date | null; edgeC: number | null };

/** Active markets passing every filter predicate (AND), sorted and limited. `now` is epoch ms. */
export async function matchMarkets(db: Db, f: ProfileFilter, now: number): Promise<Match[]> {
  const [markets, snaps, screens, ths] = await Promise.all([
    db.select().from(s.markets).where(eq(s.markets.status, "active")),
    latestSnaps(db),
    latestScreens(db),
    db.select({ conditionId: s.theses.conditionId, edgeC: s.theses.edgeC }).from(s.theses).orderBy(desc(s.theses.createdAt)),
  ]);
  const prio = new Map(screens.map((r) => [r.conditionId, r.priority]));
  const edge = new Map<string, number>();
  for (const t of ths) if (!edge.has(t.conditionId)) edge.set(t.conditionId, t.edgeC); // newest first
  const recent = new Set<string>();
  if (f.skipIfResearchedWithinHours > 0)
    for (const p of await db.select().from(s.pods).where(gte(s.pods.startedAt, new Date(now - f.skipIfResearchedWithinHours * 3_600_000))))
      if (p.status !== "failed") recent.add(p.conditionId); // a failed pod produced nothing, so it doesn't block a retry

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

export const listProfiles = async (db: Db) => (await db.select().from(s.researchProfiles).orderBy(s.researchProfiles.name)).map(toProfile);
export const getProfile = async (db: Db, id: string) => {
  const r = (await db.select().from(s.researchProfiles).where(eq(s.researchProfiles.id, id)))[0];
  return r ? toProfile(r) : null;
};
const nameTaken = async (db: Db, name: string, exceptId?: string) =>
  (await db.select({ id: s.researchProfiles.id }).from(s.researchProfiles).where(eq(s.researchProfiles.name, name))).some((r) => r.id !== exceptId);

/** `"name_taken"` instead of a profile when the unique name is in use. */
export async function createProfile(db: Db, p: ProfileInput): Promise<ResearchProfile | "name_taken"> {
  if (await nameTaken(db, p.name)) return "name_taken";
  const [r] = await db.insert(s.researchProfiles).values({ ...p, id: crypto.randomUUID() }).returning();
  return toProfile(r!);
}
/** Full replace; null = no such profile. */
export async function updateProfile(db: Db, id: string, p: ProfileInput): Promise<ResearchProfile | "name_taken" | null> {
  if (!(await getProfile(db, id))) return null;
  if (await nameTaken(db, p.name, id)) return "name_taken";
  const [r] = await db.update(s.researchProfiles).set({ ...p, updatedAt: new Date() }).where(eq(s.researchProfiles.id, id)).returning();
  return toProfile(r!);
}
export const deleteProfile = async (db: Db, id: string) => (await db.delete(s.researchProfiles).where(eq(s.researchProfiles.id, id)).returning()).length > 0;

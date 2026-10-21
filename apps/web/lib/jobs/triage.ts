import { schema as s } from "@pm/db";
import { inArray } from "drizzle-orm";
import type { TriageRule } from "../triageRules";
import { DAY, addSpend, isOpenStatus, ruleText, type Deps } from "./deps";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

export const TRIAGE_FRESH_MS = DAY; // a verdict is reused for a day unless forced
export const TRIAGE_MAX = 50; // markets per call: one cheap model call each
const CONCURRENCY = 5;
const MID_LO = 0.03, MID_HI = 0.97, MAX_SPREAD = 0.1;

type MarketRow = typeof s.markets.$inferSelect;
type SnapRow = typeof s.snapshots.$inferSelect;
export type TriageRow = typeof s.triage.$inferSelect;

/** Primitive rules, no model: open, inside the Settings day window and categories, a book with room to win, a spread and depth that can be traded. */
export function triageRules(m: MarketRow, snap: SnapRow | undefined, st: Deps["settings"], now: number): TriageRule[] {
  const out: TriageRule[] = [];
  if (!isOpenStatus(m.status) || m.status === "not_accepting") out.push("CLOSED");
  const days = m.endDate ? (m.endDate.getTime() - now) / DAY : null;
  if (days != null && days < st.filters.minDays) out.push("ENDS_TOO_SOON");
  if (days != null && days > st.filters.maxDays) out.push("ENDS_TOO_LATE");
  if (st.filters.excludedCategories.includes(m.category ?? "other")) out.push("EXCLUDED_CATEGORY");
  if (!snap?.book || snap.mid == null) out.push("NO_BOOK");
  else {
    if (snap.mid < MID_LO || snap.mid > MID_HI) out.push("PRICE_EXTREME");
    if (snap.bestBid != null && snap.bestAsk != null && snap.bestAsk - snap.bestBid > MAX_SPREAD) out.push("WIDE_SPREAD");
    if ((snap.depth5cUsd ?? 0) < st.filters.minDepthUsd) out.push("THIN_BOOK");
  }
  return out;
}

/** Newest stored verdicts for `ids`. */
export const triageOf = async (db: Deps["db"], ids: string[]) =>
  ids.length ? new Map((await db.select().from(s.triage).where(inArray(s.triage.conditionId, ids))).map((r) => [r.conditionId, r])) : new Map<string, TriageRow>();

/**
 * Triage up to TRIAGE_MAX markets: fresh books first, then the primitive rules; only markets that pass the rules reach the model.
 * Verdicts younger than TRIAGE_FRESH_MS are reused unless `force`. One model failure marks that market, never the batch.
 */
export async function triageMarkets(d: Deps, ids: string[], o: { force?: boolean } = {}): Promise<TriageRow[]> {
  const { db, settings: st } = d, now = d.now();
  ids = [...new Set(ids)].slice(0, TRIAGE_MAX);
  const have = await triageOf(db, ids);
  const todo = ids.filter((id) => o.force || !have.has(id) || now - have.get(id)!.createdAt.getTime() > TRIAGE_FRESH_MS);
  if (!todo.length) return ids.flatMap((id) => (have.has(id) ? [have.get(id)!] : []));
  await takeSnapshots(d, todo).catch((e) => console.error("triage: snapshot failed", e)); // rules read the book: a stale one would misjudge spread/depth
  const [rows, snaps] = await Promise.all([db.select().from(s.markets).where(inArray(s.markets.conditionId, todo)), latestSnaps(db, todo)]);
  const queue = [...rows];
  let spend = 0;
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const failed = triageRules(m, snaps.get(m.conditionId), st, now);
      let row: typeof s.triage.$inferInsert;
      if (failed.length) row = { conditionId: m.conditionId, verdict: "skip", score: 0, reason: failed.map((r) => r.toLowerCase().replaceAll("_", " ")).join(", "), failedRules: failed, model: null };
      else {
        try {
          const rules = (await ruleText(d.pm, m)) ?? "";
          const t = await d.triage({ question: m.question, rules, category: m.category ?? "other", daysLeft: m.endDate ? (m.endDate.getTime() - now) / DAY : 0 });
          spend += t.usage.costUsd;
          row = { conditionId: m.conditionId, verdict: t.verdict, score: t.score, reason: t.reason, failedRules: [], model: t.model };
        } catch (e) {
          console.error("triage: model call failed", m.conditionId, e);
          row = { conditionId: m.conditionId, verdict: "skip", score: 0, reason: `classifier error: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`, failedRules: [], model: null };
        }
      }
      row.createdAt = new Date(now);
      await db.insert(s.triage).values(row).onConflictDoUpdate({ target: s.triage.conditionId, set: row });
      have.set(m.conditionId, row as TriageRow);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (spend > 0) await addSpend(db, now, spend, 0);
  return ids.flatMap((id) => (have.has(id) ? [have.get(id)!] : []));
}

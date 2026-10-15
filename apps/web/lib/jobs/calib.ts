import { aggregate, brier, confidenceForCategory, logLoss, type Forecast } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";

export type ForecastRow = Forecast & { conditionId: string; resolvedAt: number };

/** One row per resolved market: judge p_hat (YES) and market mid at thesis time from the latest thesis. */
export async function forecastRows(db: Db): Promise<ForecastRow[]> {
  const outs = await db.select().from(s.outcomes);
  if (!outs.length) return [];
  const ids = outs.map((o) => o.conditionId);
  const [ths, ms] = await Promise.all([
    db.select().from(s.theses).where(inArray(s.theses.conditionId, ids)),
    db.select({ id: s.markets.conditionId, category: s.markets.category }).from(s.markets).where(inArray(s.markets.conditionId, ids)),
  ]);
  const cat = new Map(ms.map((m) => [m.id, m.category ?? "other"]));
  const latest = new Map<string, (typeof ths)[number]>();
  for (const t of ths) if (!latest.has(t.conditionId) || t.createdAt > latest.get(t.conditionId)!.createdAt) latest.set(t.conditionId, t);
  return outs.flatMap((o) => {
    const t = latest.get(o.conditionId), dt = t?.detail as { pYes?: number; pMidYes?: number; model?: string; roleMix?: string } | undefined;
    if (!t || dt?.pYes == null || dt.pMidYes == null) return [];
    return [{
      conditionId: o.conditionId, resolvedAt: o.resolvedAt.getTime(), p: dt.pYes, pMarket: dt.pMidYes,
      outcome: o.result === "YES" ? 1 : 0, category: cat.get(o.conditionId)!, model: dt.model ?? "judge", roleMix: dt.roleMix ?? "all",
    } satisfies ForecastRow];
  });
}

/** Per-category confidence c: pinned at 0.4 until 30 resolved (core), then skill vs market Brier. */
export async function categoryConfidence(db: Db, category: string | null): Promise<number> {
  const rows = (await forecastRows(db)).filter((r) => r.category === (category ?? "other"));
  const a = aggregate(rows, () => "all").all;
  return a ? confidenceForCategory(a.n, a.brier, a.marketBrier) : 0.4;
}

/** Resolved markets (had a thesis or position, no outcome yet) -> `outcomes`. Everything else is computed on read. */
export async function calibrateNightly(d: Deps) {
  return withLock(d, "calibrate", 30 * 60_000, async () => {
    const m = s.markets;
    const withThesis = d.db.selectDistinct({ c: s.theses.conditionId }).from(s.theses);
    const done = await d.db.select({ c: s.outcomes.conditionId }).from(s.outcomes);
    const cands = (await d.db.select().from(m).where(and(inArray(m.status, ["closed", "resolved"]), isNotNull(m.pmId), inArray(m.conditionId, withThesis))))
      .filter((r) => !done.some((x) => x.c === r.conditionId));
    let resolved = 0;
    for (const batch of chunks(cands, 10))
      await Promise.all(batch.map(async (r) => {
        const pm = await d.pm.market(r.pmId!).catch(() => undefined);
        const p = pm?.closed ? pm.yes_price : undefined;
        if (p === undefined || (p > 0.01 && p < 0.99)) return; // not settled (or void/split): revisit next night
        const result = p >= 0.99 ? "YES" : "NO";
        const out = result === "YES" ? 1 : 0;
        const th = await judgeP(d.db, r.conditionId);
        await d.db.insert(s.outcomes).values({
          conditionId: r.conditionId, resolvedAt: new Date(d.now()), result,
          brier: th ? brier(th, out) : null, logLoss: th ? logLoss(th, out) : null,
        }).onConflictDoNothing();
        await d.db.update(m).set({ status: "resolved" }).where(eq(m.conditionId, r.conditionId));
        resolved++;
      }));
    publish("calibration.done", { resolved });
    return { candidates: cands.length, resolved };
  });
}

/** judge p_hat (YES) of the latest thesis, for the outcome row's own brier/log_loss. */
async function judgeP(db: Db, conditionId: string): Promise<number | null> {
  const ts = await db.select().from(s.theses).where(eq(s.theses.conditionId, conditionId));
  const t = ts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const p = (t?.detail as { pYes?: number } | undefined)?.pYes;
  return p ?? null;
}

import { aggregate, brier, confidenceForCategory, drift, fitExtremize, logLoss, paperPnl, type Forecast } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { DAY, chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { putSettings } from "./settings";

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
    // the journal is derived from theses + outcomes + snapshots and rebuilt every night: a failure here must not hide the resolutions above
    const journal = await journalNightly(d).catch((e) => {
      console.error("calibrate: journal failed:", String((e as Error)?.message ?? e).slice(0, 200));
      return { error: true as const };
    });
    publish("calibration.done", { resolved });
    return { candidates: cands.length, resolved, journal };
  });
}

/** judge p_hat (YES) of the latest thesis, for the outcome row's own brier/log_loss. */
async function judgeP(db: Db, conditionId: string): Promise<number | null> {
  const ts = await db.select().from(s.theses).where(eq(s.theses.conditionId, conditionId));
  const t = ts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const p = (t?.detail as { pYes?: number } | undefined)?.pYes;
  return p ?? null;
}

// ---------------------------------------------------------------- journal (one row per thesis)
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const DRIFT = [{ key: "drift24h", ms: DAY, tol: 12 * 3_600_000 }, { key: "drift7d", ms: 7 * DAY, tol: 36 * 3_600_000 }] as const;
const SUGGEST_MIN_DELTA = 0.05;

/** Mid of the market closest to `at` (snapshot history, else market_latest), within `tol`; null when nothing that close exists. */
async function midNear(db: Db, conditionId: string, at: number, tol: number): Promise<number | null> {
  const near = await db.select({ ts: s.snapshots.ts, mid: s.snapshots.mid }).from(s.snapshots)
    .where(and(eq(s.snapshots.conditionId, conditionId), gte(s.snapshots.ts, new Date(at - tol)), lte(s.snapshots.ts, new Date(at + tol)), isNotNull(s.snapshots.mid)))
    .orderBy(asc(s.snapshots.ts));
  const best = near.reduce<(typeof near)[number] | undefined>((b, r) => (!b || Math.abs(r.ts.getTime() - at) < Math.abs(b.ts.getTime() - at) ? r : b), undefined);
  if (best) return best.mid;
  const [l] = await db.select({ ts: s.marketLatest.ts, mid: s.marketLatest.mid }).from(s.marketLatest).where(eq(s.marketLatest.conditionId, conditionId));
  return l?.mid != null && Math.abs(l.ts.getTime() - at) <= tol ? l.mid : null;
}

/**
 * Upserts a journal row per thesis (estimate, blind-agent mean, mid and liquidity at the time, R, side, stake, judge model, category);
 * resolved markets also get result, Brier (model / market / pre-reveal), log loss and paper P&L; 24h / 7d drift fill once their time has come.
 * Then refits the extremize multiplier over resolved rows and writes settings.suggested when it moves >= 0.05 from the current one.
 */
export async function journalNightly(d: Deps) {
  const { db } = d, now = d.now();
  const [ths, outs, have] = await Promise.all([
    db.select().from(s.theses),
    db.select().from(s.outcomes),
    db.select().from(s.journal),
  ]);
  const old = new Map(have.map((j) => [j.thesisId, j]));
  const out = new Map(outs.map((o) => [o.conditionId, o]));
  const todo = ths.filter((t) => !(old.get(t.id)?.result && old.get(t.id)?.drift7d != null)); // finalized rows are left alone
  const ids = [...new Set(todo.map((t) => t.conditionId))];
  const mk = new Map((await Promise.all(chunks(ids, 5000).map((c) => db.select({ id: s.markets.conditionId, category: s.markets.category, liquidity: s.markets.liquidity }).from(s.markets).where(inArray(s.markets.conditionId, c))))).flat().map((m) => [m.id, m]));
  const pods = [...new Set(todo.map((t) => t.podId))];
  const runs = (await Promise.all(chunks(pods, 5000).map((c) => db.select({ podId: s.agentRuns.podId, role: s.agentRuns.role, status: s.agentRuns.status, o: s.agentRuns.outputJson }).from(s.agentRuns).where(inArray(s.agentRuns.podId, c))))).flat();
  const pre = new Map<string, number[]>(); // blind agent estimates per pod (the judge's own row and the rules reader excluded)
  for (const r of runs) {
    const p = (r.o as { probability?: unknown } | null)?.probability;
    if (r.role !== "judge" && r.status === "ok" && fin(p)) pre.set(r.podId, [...(pre.get(r.podId) ?? []), p]);
  }

  const rows: (typeof s.journal.$inferInsert)[] = [];
  for (const t of todo) {
    const det = (t.detail ?? {}) as { pYes?: number; pMidYes?: number; e?: number; k?: number; model?: string };
    const pHat = fin(det.pYes) ? det.pYes : t.side === "NO" ? 1 - t.pHat : t.pHat;
    const midAt = fin(det.pMidYes) ? det.pMidYes : null, o = out.get(t.conditionId), prev = old.get(t.id);
    const outcome = o ? (o.result === "YES" ? 1 : 0) : null;
    const pPre = mean(pre.get(t.podId) ?? []);
    const row: typeof s.journal.$inferInsert = {
      thesisId: t.id, conditionId: t.conditionId, category: mk.get(t.conditionId)?.category ?? null, model: det.model ?? "judge",
      pHat, pPre, midAt, liquidityAt: prev?.liquidityAt ?? mk.get(t.conditionId)?.liquidity ?? null, // liquidity is not stored with the thesis: first sight is the closest we have
      r: fin(det.e) && fin(det.k) && det.k > 0 ? det.e / det.k : null, side: t.side, stake: t.sizeUsd,
      result: o?.result ?? null, resolvedAt: o?.resolvedAt ?? null,
      brierModel: outcome != null ? brier(pHat, outcome) : null,
      brierMarket: outcome != null && midAt != null ? brier(midAt, outcome) : null,
      brierPre: outcome != null && pPre != null ? brier(pPre, outcome) : null,
      logLoss: outcome != null ? logLoss(pHat, outcome) : null,
      paperPnl: outcome != null && t.sizeUsd > 0 && fin(det.k) && det.k > 0 ? paperPnl({ side: t.side === "NO" ? "NO" : "YES", stake: t.sizeUsd, aEff: det.k, outcome }) : null,
      drift24h: prev?.drift24h ?? null, drift7d: prev?.drift7d ?? null,
    };
    if (midAt != null)
      for (const { key, ms, tol } of DRIFT) {
        const at = t.createdAt.getTime() + ms;
        if (row[key] != null || now < at) continue;
        const later = await midNear(db, t.conditionId, at, tol);
        if (later != null) row[key] = drift(midAt, later, pHat);
      }
    rows.push(row);
  }
  const cols = getTableColumns(s.journal);
  for (const c of chunks(rows, 200))
    await db.insert(s.journal).values(c).onConflictDoUpdate({
      target: s.journal.thesisId,
      set: Object.fromEntries(Object.keys(c[0]!).filter((k) => k !== "thesisId").map((k) => [k, sql.raw(`excluded."${cols[k as keyof typeof cols]!.name}"`)])),
    });

  // extremize refit over every resolved row (finalized ones included)
  const all = await db.select({ pHat: s.journal.pHat, result: s.journal.result }).from(s.journal).where(isNotNull(s.journal.result));
  const fit = all.flatMap((j) => (j.pHat != null && (j.result === "YES" || j.result === "NO") ? [{ pHat: j.pHat, result: j.result as "YES" | "NO" }] : []));
  const k = fitExtremize(fit), cur = d.settings.extremize, sug = d.settings.suggested;
  let suggested: number | null = null;
  if (k != null && Math.abs(k - cur) >= SUGGEST_MIN_DELTA) {
    suggested = k;
    if (!sug || sug.extremize !== k || sug.n !== fit.length) await putSettings(db, { suggested: { extremize: k, n: fit.length, at: new Date(now).toISOString() } });
  } else if (sug) await putSettings(db, { suggested: null }); // no longer warranted
  return { theses: ths.length, upserted: rows.length, resolved: fit.length, suggested };
}


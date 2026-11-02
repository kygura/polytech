import { aggregate, brier, confidenceForCategory, drift, fitExtremize, logLoss, paperPnl, type Forecast } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { DAY, chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { putSettings } from "./settings";

export type ForecastRow = Forecast & { conditionId: string; resolvedAt: number };
type Thesis = typeof s.theses.$inferSelect;

/** Newest thesis (by createdAt) per market: one batched index read. */
async function latestThesis(db: Db, conds: string[]): Promise<Map<string, Thesis>> {
  const got = await db.theses.findEach("cond", conds.map((conditionId) => ({ conditionId })), { order: "desc", limit: 1 });
  return new Map(got.flatMap((ts) => (ts[0] ? [[ts[0].conditionId, ts[0]] as const] : [])));
}

/** One row per resolved market: judge p_hat (YES) and market mid at thesis time from the latest thesis. */
export async function forecastRows(db: Db): Promise<ForecastRow[]> {
  const outs = await db.outcomes.all();
  if (!outs.length) return [];
  const ids = outs.map((o) => o.conditionId);
  const [latest, ms] = await Promise.all([
    latestThesis(db, ids),
    Promise.all(chunks(ids, 1000).map((c) => db.markets.getMany(c))).then((x) => x.flat()),
  ]);
  const cat = new Map(ms.map((m) => [m.conditionId, m.category ?? "other"]));
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
    const [withThesis, done] = await Promise.all([d.db.theses.distinct("cond"), d.db.outcomes.pks().then((x) => new Set(x))]);
    const open = withThesis.filter((c): c is string => c !== null && !done.has(c)); // had a thesis, no outcome yet
    const cands = (await Promise.all(chunks(open, 1000).map((c) => d.db.markets.getMany(c)))).flat()
      .filter((r) => (r.status === "closed" || r.status === "resolved") && r.pmId !== null);
    const judge = await latestThesis(d.db, cands.map((r) => r.conditionId));
    let resolved = 0;
    for (const batch of chunks(cands, 10))
      await Promise.all(batch.map(async (r) => {
        const pm = await d.pm.market(r.pmId!).catch(() => undefined);
        const p = pm?.closed ? pm.yes_price : undefined;
        if (p === undefined || (p > 0.01 && p < 0.99)) return; // not settled (or void/split): revisit next night
        const result = p >= 0.99 ? "YES" : "NO";
        const out = result === "YES" ? 1 : 0;
        const th = judgeP(judge.get(r.conditionId));
        await d.db.outcomes.insertIfAbsent({ // first writer wins: a re-run never overwrites an outcome
          conditionId: r.conditionId, resolvedAt: new Date(d.now()), result,
          brier: th ? brier(th, out) : null, logLoss: th ? logLoss(th, out) : null,
        });
        await d.db.markets.update(r.conditionId, { status: "resolved" });
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
function judgeP(t: Thesis | undefined): number | null {
  const p = (t?.detail as { pYes?: number } | undefined)?.pYes;
  return p ?? null;
}

// ---------------------------------------------------------------- journal (one row per thesis)
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const DRIFT = [{ key: "drift24h", ms: DAY, tol: 12 * 3_600_000 }, { key: "drift7d", ms: 7 * DAY, tol: 36 * 3_600_000 }] as const;
const SUGGEST_MIN_DELTA = 0.05;

const MID_PAGE = 16;
type Latest = Pick<typeof s.marketLatest.$inferSelect, "ts" | "mid">;

/**
 * Mid of the market closest to `at` (snapshot history, else market_latest `l`), within `tol`; null when nothing that close exists.
 * Walks out from `at` both ways for the nearest snapshot with a mid; an equal distance goes to the earlier one (ts ascending, first wins).
 */
async function midNear(db: Db, conditionId: string, at: number, tol: number, l: Latest | undefined): Promise<number | null> {
  const side = async (o: { min: number; max: number; order: "asc" | "desc" }) => {
    for (let offset = 0; ; offset += MID_PAGE) {
      const rs = await db.snapshots.find("cond", { conditionId }, { ...o, offset, limit: MID_PAGE });
      const hit = rs.find((r) => r.mid !== null);
      if (hit || rs.length < MID_PAGE) return hit;
    }
  };
  const [before, after] = await Promise.all([side({ min: at - tol, max: at, order: "desc" }), side({ min: at, max: at + tol, order: "asc" })]);
  const dist = (r: { ts: Date }) => Math.abs(r.ts.getTime() - at);
  const best = before && (!after || dist(before) <= dist(after)) ? before : after;
  if (best) return best.mid;
  return l?.mid != null && Math.abs(l.ts.getTime() - at) <= tol ? l.mid : null;
}

/**
 * Upserts a journal row per thesis (estimate, blind-agent mean, mid and liquidity at the time, R, side, stake, judge model, category);
 * resolved markets also get result, Brier (model / market / pre-reveal), log loss and paper P&L; 24h / 7d drift fill once their time has come.
 * Then refits the extremize multiplier over resolved rows and writes settings.suggested when it moves >= 0.05 from the current one.
 */
export async function journalNightly(d: Deps) {
  const { db } = d, now = d.now();
  const [ths, outs, have] = await Promise.all([db.theses.all(), db.outcomes.all(), db.journal.all()]);
  const old = new Map(have.map((j) => [j.thesisId, j]));
  const out = new Map(outs.map((o) => [o.conditionId, o]));
  // finalized rows are left alone: resolved, and either drift 7d is in or its window (plus tolerance) is over (a market that resolved earlier never gets one)
  const todo = ths.filter((t) => { const j = old.get(t.id); return !(j?.result && (j.drift7d != null || now > t.createdAt.getTime() + DRIFT[1].ms + DRIFT[1].tol)); });
  const ids = [...new Set(todo.map((t) => t.conditionId))];
  const pods = [...new Set(todo.map((t) => t.podId))];
  const [ms, runs] = await Promise.all([
    Promise.all(chunks(ids, 5000).map((c) => db.markets.getMany(c))).then((x) => x.flat()),
    db.agentRuns.findEach("pod", pods.map((podId) => ({ podId }))).then((x) => x.flat()),
  ]);
  const mk = new Map(ms.map((m) => [m.conditionId, m]));
  const pre = new Map<string, number[]>(); // blind agent estimates per pod (the judge's own row and the rules reader excluded)
  for (const r of runs) {
    const p = (r.outputJson as { probability?: unknown } | null)?.probability;
    if (r.role !== "judge" && r.status === "ok" && fin(p)) pre.set(r.podId, [...(pre.get(r.podId) ?? []), p]);
  }

  const rows: (typeof s.journal.$inferInsert)[] = [];
  const due: { row: (typeof rows)[number]; key: (typeof DRIFT)[number]["key"]; c: string; at: number; tol: number; midAt: number; pHat: number }[] = [];
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
        due.push({ row, key, c: t.conditionId, at, tol, midAt, pHat });
      }
    rows.push(row);
  }
  // drift windows whose time has come: market_latest fallback in one read, snapshot lookups in parallel batches
  if (due.length) {
    const latest = new Map((await db.marketLatest.getMany([...new Set(due.map((x) => x.c))])).map((l) => [l.conditionId, l]));
    for (const batch of chunks(due, 25))
      await Promise.all(batch.map(async (x) => {
        const later = await midNear(db, x.c, x.at, x.tol, latest.get(x.c));
        if (later != null) x.row[x.key] = drift(x.midAt, later, x.pHat);
      }));
  }
  // ON CONFLICT (thesis_id) DO UPDATE SET every column = excluded (full row overwrite)
  await db.journal.upsertMany(rows);

  // extremize refit over every resolved row (finalized ones included)
  const all = await db.journal.find("withResult", {});
  const fit = all.flatMap((j) => (j.pHat != null && (j.result === "YES" || j.result === "NO") ? [{ pHat: j.pHat, result: j.result as "YES" | "NO" }] : []));
  const k = fitExtremize(fit), cur = d.settings.extremize, sug = d.settings.suggested;
  let suggested: number | null = null;
  if (k != null && Math.abs(k - cur) >= SUGGEST_MIN_DELTA) {
    suggested = k;
    if (!sug || sug.extremize !== k || sug.n !== fit.length) await putSettings(db, { suggested: { extremize: k, n: fit.length, at: new Date(now).toISOString() } });
  } else if (sug) await putSettings(db, { suggested: null }); // no longer warranted
  return { theses: ths.length, upserted: rows.length, resolved: fit.length, suggested };
}


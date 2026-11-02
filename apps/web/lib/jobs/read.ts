import { aggregate, effectiveMode, gateProgress, gateStats, realizedEdge, reliabilityBins, type Mode, type Side, type Steering, type Tier, type WatchCore } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { createPm } from "@pm/pm";
import { currentMode } from "./autonomy";
import { categoryConfidence, forecastRows } from "./calib";
import { DAY, dbReady, defaultNow, envExchange, ruleText, type Deps } from "./deps";
import { liveFilled, orderUi, uiState } from "./live";
import { compileFilter, screenerRows } from "./markets";
import { memo, memoClear } from "./memo";
import { LIVE_OPEN, exposureOf } from "./paper";
import { latestScreens, latestSnaps, shortlist, type StructDetail } from "./screen";
import { getSettings, putSettings } from "./settings";
import { reconStatus } from "./sync";

/** Everything the API needs for reads. */
export type ReadDeps = Pick<Deps, "db" | "now"> & { exchangeConfigured?: boolean; pm?: Deps["pm"] }; // pm: rules text for the market detail (not stored)
export const readDeps = async (): Promise<ReadDeps> => ({ db: await dbReady(), now: defaultNow, exchangeConfigured: envExchange() !== null, pm: createPm() });

type Th = typeof s.theses.$inferSelect;
type ThDetail = { thesis?: string; pYes?: number; pMidYes?: number; k?: number; e?: number; shares?: number; payoff?: number; expectedProfit?: number; capped?: boolean; judgeConfidence?: number; trigger?: string; model?: string; strongFacts?: number; keyEvidence?: { url: string; claim: string; reputation: string; claim_strength: string; why: string; quoteCheck?: string }[] };
const dt = (t: Th) => (t.detail ?? {}) as ThDetail;

type Mk = typeof s.markets.$inferSelect;
const nonNull = <T>(x: T | null | undefined): x is T => x != null;
const byIdAsc = (a: { id: number }, b: { id: number }) => a.id - b.id;
/** conditionId -> market row, for code-side joins (missing markets are absent: a left join reads null, an inner join drops the row). */
const marketsById = async (db: Db, ids: Iterable<string>) => new Map((await db.markets.getMany([...new Set(ids)])).map((m) => [m.conditionId, m]));
/**
 * `inner join ... order by ... limit n`: `read(k)` returns the first k rows in order, `join` maps each to its joined row or null (a
 * missing market). Dropped rows do not count toward the limit, so read further (doubling) until n survive or the source runs out.
 * One read in the usual case.
 */
async function limitJoined<R, J>(n: number, read: (k: number) => Promise<R[]>, join: (rows: R[]) => Promise<(J | null)[]>): Promise<J[]> {
  for (let k = n; ; k *= 2) {
    const rows = await read(k);
    const joined = (await join(rows)).filter(nonNull);
    if (joined.length >= n || rows.length < k) return joined.slice(0, n);
  }
}

/** Newest thesis per market (createdAt desc, id desc): per-market index reads for `ids`, else one scan of theses. */
const latestTheses = async (db: Db, ids?: string[]) => {
  const rows = ids ? (await db.theses.findEach("cond", ids.map((conditionId) => ({ conditionId })), { order: "desc", limit: 1 })).flat() : await db.theses.all();
  const m = new Map<string, Th>();
  for (const t of rows) {
    const cur = m.get(t.conditionId);
    if (!cur || t.createdAt.getTime() > cur.createdAt.getTime() || (t.createdAt.getTime() === cur.createdAt.getTime() && t.id > cur.id)) m.set(t.conditionId, t);
  }
  return m;
};

// ---------------------------------------------------------------- watchlist
type Nullable<T> = { [K in keyof T]: T[K] | null };
export type WatchlistRow = {
  conditionId: string; question: string; category: string | null; tier: Tier | null;
  pinned: boolean; muted: boolean; shortlisted: boolean; researching: boolean;
  priority: number | null; midNow: number | null; // YES-token mid in the latest snapshot
  daysLeft: number; endDate: number | null;
  thesisId: string | null; thesisAgeH: number | null; expired: boolean | null; capped: boolean | null;
  nextCatalyst: string | null; // "YYYY-MM-DD label", first not yet passed
  structural: StructDetail | null;
} & Nullable<Omit<WatchCore, "daysLeft">>; // side, pMid, pHat, c, pPost, k, e, edgeC, r, payoff, rAnn, sizeUsd, shares, expectedProfit, rank (null until researched)
export type StructuralRow = {
  conditionId: string; question: string; category: string | null; pinned: boolean; muted: boolean;
  type: StructDetail["type"]; kind: StructDetail["kind"] | null; legs: number; sum: number | null; lockedC: number; sizeUsd: number; daysLeft: number; detail: StructDetail;
};
export type WatchSort = "rank" | "edge" | "r_ann" | "days";
const KEY: Record<WatchSort, (r: WatchlistRow) => number | null> = {
  rank: (r) => r.rank, edge: (r) => r.edgeC, r_ann: (r) => r.rAnn, days: (r) => (r.daysLeft == null ? null : -r.daysLeft), // days: soonest first
};

export function watchlist(r: ReadDeps, tab: "small-cap" | "size", sort?: WatchSort, o?: { includeMuted?: boolean; limit?: number }): Promise<WatchlistRow[]>;
export function watchlist(r: ReadDeps, tab: "structural", sort?: WatchSort, o?: { includeMuted?: boolean; limit?: number }): Promise<StructuralRow[]>;
export function watchlist(r: ReadDeps, tab: Tier | "structural", sort: WatchSort = "rank", o: { includeMuted?: boolean; limit?: number } = {}): Promise<WatchlistRow[] | StructuralRow[]> {
  // the structural tab only moves with a screen run or a pin/mute flip (both call memoClear): a 10 s cache absorbs polling and shares one in-flight read
  return tab === "structural" ? memo(`watch:structural:${sort}:${!!o.includeMuted}:${o.limit ?? ""}`, 10_000, () => watchlistRead(r, tab, sort, o)) : watchlistRead(r, tab, sort, o);
}
async function watchlistRead(r: ReadDeps, tab: Tier | "structural", sort: WatchSort, o: { includeMuted?: boolean; limit?: number }): Promise<WatchlistRow[] | StructuralRow[]> {
  const { db } = r, now = r.now(), limit = o.limit ?? 100;
  // only the rows this tab can show (shortlist + markets with a thesis, or the structural ones), not the whole ~16k-market run
  const [sl, ths] = await Promise.all([shortlist(db, 20), latestTheses(db)]);
  const screens = tab === "structural" ? await latestScreens(db, { structural: true }) : await latestScreens(db, { ids: [...new Set([...sl.map((x) => x.conditionId), ...ths.keys()])] });
  const ids = screens.map((x) => x.conditionId);
  if (!ids.length) return [];
  const [mk, flags, snaps, run] = await Promise.all([
    db.markets.getMany(ids),
    db.marketFlags.all(),
    latestSnaps(db, ids),
    db.pods.find("status", { status: "running" }).then((ps) => ps.map((p) => ({ c: p.conditionId }))),
  ]);
  const M = new Map(mk.map((m) => [m.conditionId, m])), F = new Map(flags.map((f) => [f.conditionId, f]));
  const SL = new Set(sl.map((x) => x.conditionId)), RUN = new Set(run.map((x) => x.c));
  const vis = (id: string) => o.includeMuted || !F.get(id)?.muted;
  const days = (id: string) => ((M.get(id)?.endDate?.getTime() ?? now) - now) / DAY;

  if (tab === "structural")
    return screens
      .filter((x) => x.structuralFlag && x.structuralDetail && M.has(x.conditionId) && vis(x.conditionId))
      .map((x): StructuralRow => {
        const m = M.get(x.conditionId)!, det = x.structuralDetail as StructDetail;
        return {
          conditionId: x.conditionId, question: m.question, category: m.category, pinned: !!F.get(x.conditionId)?.pinned, muted: !!F.get(x.conditionId)?.muted,
          type: det.type, kind: det.kind ?? null, legs: det.legs.length, sum: det.sum, lockedC: det.lockedC, sizeUsd: det.sizeUsd, daysLeft: days(x.conditionId), detail: det,
        };
      })
      .sort((a, b) => (sort === "days" ? a.daysLeft - b.daysLeft : b.lockedC - a.lockedC))
      .slice(0, limit);

  const rows = screens
    .filter((x) => x.tier === tab && M.has(x.conditionId) && vis(x.conditionId) && (SL.has(x.conditionId) || ths.has(x.conditionId)))
    .map((x): WatchlistRow => {
      const m = M.get(x.conditionId)!, t = ths.get(x.conditionId), det = t ? dt(t) : undefined, f = F.get(x.conditionId);
      const cat = t?.catalysts.filter((c) => Date.parse(c.slice(0, 10)) >= now - DAY).sort()[0] ?? null;
      return {
        conditionId: x.conditionId, question: m.question, category: m.category, tier: tab,
        pinned: !!f?.pinned, muted: !!f?.muted, shortlisted: SL.has(x.conditionId), researching: RUN.has(x.conditionId),
        priority: x.priority, midNow: snaps.get(x.conditionId)?.mid ?? null, daysLeft: days(x.conditionId), endDate: m.endDate?.getTime() ?? null,
        thesisId: t?.id ?? null, thesisAgeH: t ? (now - t.createdAt.getTime()) / 3_600_000 : null,
        expired: t?.expiresAt ? t.expiresAt.getTime() < now : null, capped: det ? !!det.capped : null, nextCatalyst: cat,
        structural: x.structuralFlag ? (x.structuralDetail as StructDetail) : null,
        side: (t?.side as Side | undefined) ?? null,
        pMid: t && det?.pMidYes != null ? (t.side === "NO" ? 1 - det.pMidYes : det.pMidYes) : null,
        pHat: t?.pHat ?? null, c: t?.c ?? null, pPost: t?.pPost ?? null, k: det?.k ?? null, e: det?.e ?? null, edgeC: t?.edgeC ?? null,
        r: det?.e != null && det.k ? det.e / det.k : null, payoff: det?.payoff ?? null, rAnn: t?.rAnn ?? null, sizeUsd: t?.sizeUsd ?? null,
        shares: det?.shares ?? null, expectedProfit: det?.expectedProfit ?? null, rank: t?.rank ?? null,
      };
    });
  const key = KEY[sort];
  return rows.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity) || (b.priority ?? 0) - (a.priority ?? 0)).slice(0, limit);
}

const NO_THESIS = {
  thesisId: null, thesisAgeH: null, expired: null, capped: null, nextCatalyst: null, structural: null,
  side: null, pMid: null, pHat: null, c: null, pPost: null, k: null, e: null, edgeC: null, r: null, payoff: null, rAnn: null, sizeUsd: null, shares: null, expectedProfit: null, rank: null,
} as const;
/** Fallback list before any screen/thesis exists (fresh database): open markets with a mid and a future end date, by priority, then 24h volume, then liquidity. Muted hidden. */
export async function topMarkets(r: ReadDeps, limit = 100): Promise<WatchlistRow[]> {
  const { db } = r, now = r.now();
  const { match, compare } = compileFilter({
    price: { min: 0 }, daysToResolution: { min: 0 }, muted: false,
    sort: [{ field: "priority", dir: "desc" }, { field: "volume24h", dir: "desc" }, { field: "liquidity", dir: "desc" }],
  }, now);
  const rows = (await screenerRows(db)).filter((x) => x.ml !== null && match(x)).sort(compare).slice(0, limit) // inner join market_latest
    .map(({ m, ml, flags }) => ({ conditionId: m.conditionId, question: m.question, category: m.category, endDate: m.endDate, priority: ml!.priority, mid: ml!.mid, pinned: flags?.pinned ?? null }));
  return rows.map((x): WatchlistRow => ({
    conditionId: x.conditionId, question: x.question, category: x.category, tier: null,
    pinned: !!x.pinned, muted: false, shortlisted: false, researching: false,
    priority: x.priority, midNow: x.mid, daysLeft: ((x.endDate?.getTime() ?? now) - now) / DAY, endDate: x.endDate?.getTime() ?? null,
    ...NO_THESIS,
  }));
}

// ---------------------------------------------------------------- market detail
export async function marketDetail(r: ReadDeps, conditionId: string) {
  const { db } = r, now = r.now();
  const m = await db.markets.get(conditionId);
  if (!m) return null;
  const [snap, ths, flag, scr, hist, pos, pods, latest, st, rules] = await Promise.all([
    latestSnaps(db, [conditionId]).then((x) => x.get(conditionId) ?? null),
    db.theses.find("cond", { conditionId }, { order: "desc" }),
    db.marketFlags.get(conditionId),
    db.screens.first("cond", { conditionId }, { order: "desc" }),
    db.snapshots.find("cond", { conditionId }, { order: "desc", limit: 500 }).then((xs) => xs.map((x) => ({ ts: x.ts, mid: x.mid }))),
    db.positions.find("cond", { conditionId }, { order: "desc" }).then((xs) => xs.filter((p) => p.paper)), // by id desc
    db.pods.find("cond", { conditionId }, { order: "desc" }),
    db.marketLatest.get(conditionId),
    getSettings(db),
    r.pm ? ruleText(r.pm, m) : undefined,
  ]);
  const t = ths[0] ?? null;
  const podId = t?.podId ?? pods.find((p) => p.status === "done")?.id;
  const [evidence, agents] = podId
    ? await Promise.all([
        db.evidence.find("pod", { podId }),
        db.agentRuns.find("pod", { podId }), // by id asc
      ])
    : [[], []];
  return {
    market: {
      conditionId, question: m.question, rules: rules ?? "", category: m.category, tags: m.tags, eventId: m.eventId, negRiskGroup: m.negRiskGroup,
      endDate: m.endDate?.getTime() ?? null, daysLeft: ((m.endDate?.getTime() ?? now) - now) / DAY, feeRate: m.feeRate, feeExponent: m.feeExponent, tickSize: m.tickSize, status: m.status,
      yesTokenId: m.yesTokenId, noTokenId: m.noTokenId, pinned: !!flag?.pinned, muted: !!flag?.muted,
      liquidity: m.liquidity, vol24h: m.vol24h, resolutionSource: m.resolutionSource,
    },
    /** DESIGN 12.6 Metrics + badges: the market_latest row (null until the snapshot job has written it). Times are epoch ms. */
    latest: latest && { ...latest, ts: latest.ts.getTime(), midChangedAt: latest.midChangedAt?.getTime() ?? null, lastTradeTs: latest.lastTradeTs?.getTime() ?? null },
    snapshot: snap && { ts: snap.ts.getTime(), mid: snap.mid, bestBid: snap.bestBid, bestAsk: snap.bestAsk, depth5cUsd: snap.depth5cUsd, vol24h: snap.vol24h, oi: snap.oi, top10Share: snap.top10Share, bids: snap.book?.bids ?? [], asks: snap.book?.asks ?? [], netFlow: snap.book?.netFlow ?? 0 },
    history: hist.map((h) => ({ ts: h.ts.getTime(), mid: h.mid })).reverse(),
    screen: scr && { ts: scr.ts.getTime(), R: scr.r, I: scr.i, L: scr.l, T: scr.t, C: scr.c, priority: scr.priority, tier: scr.tier, structural: scr.structuralDetail },
    thesis: t && {
      id: t.id, podId: t.podId, createdAt: t.createdAt.getTime(), expiresAt: t.expiresAt?.getTime() ?? null, side: t.side as Side, pHat: t.pHat, c: t.c, pPost: t.pPost,
      edgeC: t.edgeC, sizeUsd: t.sizeUsd, rAnn: t.rAnn, rank: t.rank, catalysts: t.catalysts, killCriteria: t.killCriteria, ...dt(t),
      extremize: st.extremize, // the log-odds multiplier sizing applies to pYes (visitor sizing must use the same)
    },
    thesisMarkers: ths.map((x) => ({ createdAt: x.createdAt.getTime(), pHat: x.pHat, side: x.side as Side })),
    evidence: evidence.map((e) => ({ id: e.id, role: e.agentRole, claim: e.claim, quote: e.quote, url: e.url, direction: e.direction, publishedAt: e.publishedAt?.getTime() ?? null, retrievedAt: e.retrievedAt.getTime() })),
    agents: agents.map((a) => {
      const o = a.outputJson as { probability?: number | null; confidence?: number; p_hat?: number } | null;
      return { role: a.role, model: a.model, status: a.status, probability: o?.probability ?? o?.p_hat ?? null, confidence: o?.confidence ?? null, durationS: a.durationS, usage: a.usage as { inputTokens: number; outputTokens: number; costUsd: number } | null };
    }),
    pod: pods[0] ? { id: pods[0].id, status: pods[0].status, trigger: pods[0].trigger, startedAt: pods[0].startedAt.getTime() } : null,
    positions: pos.map((p) => ({ id: p.id, tokenId: p.tokenId, size: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl, openedAt: p.openedAt.getTime(), closedAt: p.closedAt?.getTime() ?? null })),
  };
}

// ---------------------------------------------------------------- fleet
export async function fleet(r: ReadDeps) {
  const { db } = r, now = r.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const [st, ps] = await Promise.all([getSettings(db), db.pods.find("byStarted", {}, { order: "desc", limit: 50 })]);
  const pids = [...new Set(ps.flatMap((p) => (p.profileId ? [p.profileId] : [])))];
  const [M, profs, runs, sp] = await Promise.all([
    marketsById(db, ps.map((p) => p.conditionId)),
    db.researchProfiles.getMany(pids),
    db.agentRuns.findEach("pod", ps.map((p) => ({ podId: p.id }))).then((x) => x.flat().sort(byIdAsc)),
    db.spend.get(day),
  ]);
  const pods = ps.map((p) => ({ p, q: M.get(p.conditionId)?.question ?? null })); // left join markets
  const names = new Map(profs.map((x) => [x.id, x.name]));
  type U = { inputTokens: number; outputTokens: number; costUsd: number };
  const usage = (a: (typeof runs)[number]) => (a.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }) as U;
  const todays = pods.filter((x) => x.p.startedAt.toISOString().slice(0, 10) === day);
  const todayRuns = runs.filter((a) => todays.some((x) => x.p.id === a.podId));
  return {
    budget: {
      podsToday: todays.length, maxPodsPerDay: st.budget.maxPodsPerDay,
      activeSandboxes: pods.filter((x) => x.p.status === "running").length * Math.min(5, st.budget.maxConcurrentSandboxes), maxConcurrentSandboxes: st.budget.maxConcurrentSandboxes,
      sandboxS: sp?.sandboxS ?? 0, spendTodayUsd: sp?.anthropicUsd ?? 0, dailySpendCapUsd: st.budget.dailySpendCapUsd,
      tokensIn: todayRuns.reduce((t, a) => t + usage(a).inputTokens, 0), tokensOut: todayRuns.reduce((t, a) => t + usage(a).outputTokens, 0),
    },
    pods: pods.map(({ p, q }) => ({
      id: p.id, conditionId: p.conditionId, question: q, trigger: p.trigger, profileId: p.profileId, profileName: p.profileId ? names.get(p.profileId) ?? null : null, steering: p.steering as Partial<Steering> | null, steered: p.steering != null, steeringQuestion: (p.steering as { question?: string } | null)?.question ?? null, status: p.status, stage: p.stage ?? null, startedAt: p.startedAt.getTime(), costSandboxS: p.costSandboxS,
      agents: runs.filter((a) => a.podId === p.id).map((a) => ({ role: a.role, model: a.model, status: a.status, durationS: a.durationS, usage: usage(a), output: a.outputJson })),
    })),
  };
}

// ---------------------------------------------------------------- research desk
const DEFAULT_AGENTS = 5; // rules, source, base_rate, news, red_team (custom roles add rows as they start)

/** Research runs for the desk: everything running plus the last day's runs (or the given markets'), with agent progress, failure reason and verdict. */
export async function researchLive(r: ReadDeps, o: { ids?: string[]; limit?: number } = {}) {
  const { db } = r, now = r.now();
  const limit = o.limit ?? 40, day = new Date(now).toISOString().slice(0, 10);
  const [st, ps, sp, podsToday] = await Promise.all([
    getSettings(db),
    o.ids?.length
      ? db.pods.find("cond", o.ids.map((conditionId) => ({ conditionId })), { order: "desc", limit })
      : db.pods.find("byStarted", {}, { min: now - DAY, order: "desc", limit }),
    db.spend.get(day),
    db.pods.count("byStarted", {}, { min: new Date(`${day}T00:00:00Z`) }),
  ]);
  const pids = ps.map((p) => p.id);
  const [M, allRuns, ths] = pids.length
    ? await Promise.all([
        marketsById(db, ps.map((p) => p.conditionId)),
        db.agentRuns.findEach("pod", pids.map((podId) => ({ podId }))).then((x) => x.flat()), // by id asc per pod
        db.theses.findEach("pod", pids.map((podId) => ({ podId }))).then((x) => x.flat()), // by createdAt asc per pod: the newest wins below
      ])
    : [new Map<string, Mk>(), [], []];
  const pods = ps.map((p) => ({ p, q: M.get(p.conditionId)?.question ?? null })); // left join markets
  const runs = allRuns.map((a) => ({ podId: a.podId, role: a.role, status: a.status }));
  const judged = allRuns.filter((a) => a.role === "judge" && a.status === "ok").map((a) => ({ podId: a.podId, out: a.outputJson }));
  const th = new Map(ths.map((t) => [t.podId, t]));
  const judge = new Map(judged.map((j) => [j.podId, j.out as { p_hat?: number; thesis?: string; confidence?: number } | null]));
  return {
    budget: {
      running: pods.filter((x) => x.p.status === "running").length, maxRunning: st.budget.maxConcurrentSandboxes,
      podsToday, maxPodsPerDay: st.budget.maxPodsPerDay, spendTodayUsd: sp?.anthropicUsd ?? 0, dailySpendCapUsd: st.budget.dailySpendCapUsd,
    },
    runs: pods.map(({ p, q }) => {
      const ag = runs.filter((a) => a.podId === p.id && a.role !== "judge");
      const t = th.get(p.id), d = t ? dt(t) : null;
      return {
        podId: p.id, conditionId: p.conditionId, question: q, trigger: p.trigger, status: p.status, stage: p.stage ?? null, error: p.error ?? null,
        startedAt: p.startedAt.getTime(),
        agents: { total: Math.max(DEFAULT_AGENTS, ag.length), done: ag.filter((a) => a.status === "ok").length, failed: ag.filter((a) => a.status !== "ok" && a.status !== "running").length },
        // a finished pod without a thesis found no edge worth sizing (or the judge's p-hat matched the price)
        verdict: t ? { side: t.side as Side, pYes: d?.pYes ?? null, midAtThesis: d?.pMidYes ?? null, edgeC: t.edgeC, sizeUsd: t.sizeUsd, confidence: t.c, thesis: d?.thesis ?? null } : null,
        judge: !t && judge.get(p.id) ? { pYes: judge.get(p.id)!.p_hat ?? null, thesis: judge.get(p.id)!.thesis ?? null } : null, // done, but no trade cleared the sizing
      };
    }),
  };
}

// ---------------------------------------------------------------- calibration
export async function calibration(r: ReadDeps, o: { category?: string; model?: string; sinceDays?: number } = {}) {
  const all = await forecastRows(r.db);
  const rows = all.filter((x) => (!o.category || x.category === o.category) && (!o.model || x.model === o.model) && (!o.sinceDays || x.resolvedAt >= r.now() - o.sinceDays * DAY));
  const cats = aggregate(all, (x) => x.category);
  return {
    n: rows.length,
    overall: aggregate(rows, () => "all").all ?? null, // { n, brier, logLoss, marketBrier }
    byCategory: Object.fromEntries(await Promise.all(Object.entries(cats).map(async ([k, v]) => [k, { ...v, c: await categoryConfidence(r.db, k), gate: `${v.n}/30` }]))),
    byModel: aggregate(rows, (x) => x.model),
    byRoleMix: aggregate(rows, (x) => x.roleMix),
    bins: reliabilityBins(rows), // 10 bins { lo, hi, n, meanPredicted, observed }
  };
}

// ---------------------------------------------------------------- paper book
export async function paperBook(r: ReadDeps) {
  const { db } = r;
  const allPos = await db.positions.find("book", { paper: true }, { order: "desc" }); // by id desc
  const PM = await marketsById(db, allPos.map((p) => p.conditionId));
  const pos = allPos.flatMap((p) => { const m = PM.get(p.conditionId); return m ? [{ p, m }] : []; }); // inner join markets
  const ids = [...new Set(pos.map((x) => x.p.conditionId))];
  const [snaps, outs, ords] = ids.length
    ? await Promise.all([
        latestSnaps(db, ids),
        db.outcomes.getMany(ids),
        db.orders.findEach("cond", ids.map((conditionId) => ({ conditionId }))).then((x) => x.flat()),
      ])
    : [new Map<string, never>(), [], []];
  const [FT, ots] = ords.length
    ? await Promise.all([
        db.fills.findEach("order", ords.map((o) => ({ orderId: o.id }))).then((x) => x.flat()),
        db.theses.getMany([...new Set(ords.map((o) => o.thesisId))]),
      ])
    : [[], []];
  const fillTs = new Map(FT.map((f) => [f.orderId, f.ts.getTime()]));
  const resolvedAt = new Map(outs.map((o) => [o.conditionId, o.resolvedAt.getTime()]));
  const OT = new Map(ots.map((x) => [x.id, x]));
  const O = new Map(outs.map((o) => [o.conditionId, o.result]));
  const positions = pos.map(({ p, m }) => {
    const tid = ords.filter((o) => o.conditionId === p.conditionId && o.tokenId === p.tokenId && (fillTs.get(o.id) ?? 0) <= p.openedAt.getTime())
      .sort((a, b) => (fillTs.get(b.id) ?? 0) - (fillTs.get(a.id) ?? 0))[0]?.thesisId; // latest order filled at or before this position opened // the order's thesis, not the latest
    const t = tid ? OT.get(tid) : undefined, e = t ? (dt(t).e ?? t.edgeC / 100) : null;
    const yes = snaps.get(p.conditionId)?.mid ?? null;
    const midNow = yes == null ? null : p.tokenId === m.yesTokenId ? yes : 1 - yes;
    const closed = p.closedAt != null;
    return {
      id: p.id, conditionId: p.conditionId, question: m.question, side: (p.tokenId === m.yesTokenId ? "YES" : "NO") as Side, tokenId: p.tokenId,
      size: p.size, avgCost: p.avgCost, midNow, unrealizedUsd: closed || midNow == null ? null : p.size * (midNow - p.avgCost),
      modeledEdgeC: e == null ? null : e * 100, realizedEdgeC: closed ? (p.realizedPnl / p.size) * 100 : null,
      openedAt: p.openedAt.getTime(), closedAt: p.closedAt?.getTime() ?? null, result: O.get(p.conditionId) ?? null, realizedPnl: p.realizedPnl,
      thesisId: tid ?? null, modeledE: e, viaOutcome: closed && (resolvedAt.get(p.conditionId) ?? Infinity) <= p.closedAt!.getTime(),
    };
  });
  // L1 autonomy fills and manual paper trades (modeAtSend "manual", from the Trade page)
  // fills of paper L1/manual orders whose market exists, newest fill id first, 200: fill ids per order (no rows), then the 200 rows
  const l1 = (await db.orders.find("book", { paper: true })).filter((o) => o.modeAtSend === "L1" || o.modeAtSend === "manual");
  const [fids, LM] = await Promise.all([db.fills.idsEach("order", l1.map((o) => ({ orderId: o.id }))), marketsById(db, l1.map((o) => o.conditionId))]);
  const top = l1.flatMap((o, i) => (LM.has(o.conditionId) ? (fids[i] ?? []).map((id) => ({ id: Number(id), o })) : [])).sort((a, b) => b.id - a.id).slice(0, 200);
  const FR = new Map((await db.fills.getMany(top.map((x) => x.id))).map((f) => [f.id, f]));
  const fl = top.flatMap(({ id, o }) => {
    const f = FR.get(id), m = LM.get(o.conditionId)!;
    return f ? [{ f, o, q: m.question, yesToken: m.yesTokenId }] : [];
  });
  const T = new Map((await db.theses.getMany([...new Set(fl.map((x) => x.o.thesisId))])).map((t) => [t.id, t]));
  const fills = fl.map(({ f, o, q, yesToken }) => {
    const t = T.get(o.thesisId), k = t ? (dt(t).k ?? null) : null;
    return {
      ts: f.ts.getTime(), conditionId: o.conditionId, question: q, side: (t?.side ?? (o.tokenId === yesToken ? "YES" : "NO")) as Side,
      action: o.side as "BUY" | "SELL", manual: o.modeAtSend === "manual", price: f.price, size: f.size, fee: f.fee, modeledK: k,
      slipC: k == null ? null : (f.price + f.fee / f.size - k) * 100, paper: true, violations: o.status.includes("!") ? o.status.split("!")[1]!.split(",") : [],
    };
  });
  const closed = positions.filter((p) => p.closedAt != null);
  const edge = realizedEdge(closed.flatMap((p) => (p.modeledE == null ? [] : [{ shares: p.size, avgPrice: p.avgCost, fee: 0, modeledEdge: p.modeledE, outcome: (p.viaOutcome ? (p.result === p.side ? 1 : 0) : p.avgCost + p.realizedPnl / p.size) as 0 | 1 }])));
  const open = positions.filter((p) => p.closedAt == null);
  const modeledUsd = positions.reduce((t, p) => t + p.size * (p.modeledE ?? 0), 0);
  const realizedUsd = closed.reduce((t, p) => t + p.realizedPnl, 0);
  return {
    summary: {
      open: open.length, closed: closed.length,
      paperPnlUsd: realizedUsd + open.reduce((t, p) => t + (p.unrealizedUsd ?? 0), 0), modeledEdgeUsd: modeledUsd, realizedEdgeUsd: realizedUsd,
      capture: closed.length && modeledUsd > 0 ? realizedUsd / closed.reduce((t, p) => t + p.size * (p.modeledE ?? 0), 0) : null,
      perShare: edge, // { n, realized, modeled, gap } over resolved trades
    },
    positions: positions.map(({ modeledE: _, viaOutcome: __, ...p }) => p),
    fills,
  };
}

// ---------------------------------------------------------------- live book
/** Live positions, open orders, last 50 fills, recon. orderId is the exchange (clob) id; markPrice falls back to avgPrice (unrealized 0) when the market has no snapshot. */
export async function bookLive(r: ReadDeps) {
  const { db } = r;
  const joinM = async <T extends { conditionId: string }>(rows: T[]) => {
    const M = await marketsById(db, rows.map((x) => x.conditionId));
    return rows.map((x) => { const m = M.get(x.conditionId); return m ? { x, m } : null; }); // inner join markets
  };
  const [pos, filled, ords, fl] = await Promise.all([
    db.positions.find("open", { paper: false }, { order: "desc" }).then(joinM).then((xs) => xs.filter(nonNull).map(({ x, m }) => ({ p: x, m }))), // by id desc
    liveFilled(db),
    db.orders.find("bookStatus", LIVE_OPEN.map((status) => ({ paper: false, status })), { order: "desc" }).then(joinM) // by createdAt desc
      .then((xs) => xs.filter(nonNull).map(({ x, m }) => ({ o: x, q: m.question }))),
    // last 50 live fills by ts desc, id desc whose order and market exist
    limitJoined(50, async (k) => {
      const page = await db.fills.find("book", { paper: false }, { order: "desc", limit: k });
      const last = page.length === k ? page.at(-1)!.ts : null; // a ts tie at the page edge: read every row of that ts, then order ties by id
      const ties = last ? await db.fills.find("book", { paper: false }, { min: last, max: last }) : [];
      const rows = [...new Map([...page, ...ties].map((f) => [f.id, f])).values()];
      return rows.sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id);
    }, async (fs) => {
      const O = new Map((await db.orders.getMany([...new Set(fs.map((f) => f.orderId))])).map((o) => [o.id, o]));
      const M = await marketsById(db, [...O.values()].map((o) => o.conditionId));
      return fs.map((f) => { const o = O.get(f.orderId), m = o && M.get(o.conditionId); return o && m ? { f, o, q: m.question } : null; });
    }),
  ]);
  const snaps = pos.length ? await latestSnaps(db, [...new Set(pos.map((x) => x.p.conditionId))]) : new Map<string, never>();
  const positions = pos.map(({ p, m }) => {
    const yes = snaps.get(p.conditionId)?.mid ?? null, isYes = p.tokenId === m.yesTokenId;
    const mark = yes == null ? p.avgCost : isYes ? yes : 1 - yes;
    return { conditionId: p.conditionId, question: m.question, tokenId: p.tokenId, outcome: (isYes ? "YES" : "NO") as "YES" | "NO", shares: p.size, avgPrice: p.avgCost, markPrice: mark, unrealizedUsd: p.size * (mark - p.avgCost) };
  });
  const openOrders = ords.map(({ o, q }) => ({
    orderId: o.clobOrderId ?? o.id, conditionId: o.conditionId, question: q, side: o.side as "BUY" | "SELL", price: o.limitPrice, shares: o.size,
    filledShares: filled.get(o.id) ?? 0, status: orderUi(o.status, filled.get(o.id) ?? 0, o.size), expiresAt: o.expiresAt?.getTime() ?? null,
    approval: o.approval as "auto" | "user" | null, modeAtSend: o.modeAtSend, setId: o.setId,
  }));
  const fills = fl.map(({ f, o, q }) => ({ tradeId: f.tradeId ?? String(f.id), conditionId: o.conditionId, question: q, side: o.side as "BUY" | "SELL", price: f.price, shares: f.size, feeUsd: f.fee, at: f.ts.getTime(), approval: o.approval as "auto" | "user" | null, modeAtSend: o.modeAtSend, setId: o.setId }));
  return { positions, openOrders, fills, recon: await reconStatus(r) };
}

// ---------------------------------------------------------------- autonomy
/**
 * L2->L3 / L3->L4 gate inputs from live single-leg orders that have fills (set legs are excluded: their cap is not a modeled price).
 * modeled = side mid at proposal; approved = a human sent it. Edge: realized P&L of live positions closed in the last 30 d per share bought in that window, in cents.
 */
export async function liveGateStats(db: ReadDeps["db"], now: Date) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const ords = (await db.orders.find("book", { paper: false })).filter((o) => o.setId === null);
  const [fl, pr, closed] = await Promise.all([
    db.fills.findEach("order", ords.map((o) => ({ orderId: o.id }))),
    db.proposals.getMany([...new Set(ords.flatMap((o) => (o.proposalId ? [o.proposalId] : [])))]),
    db.positions.find("closed", { paper: false }, { min: since }),
  ]);
  // inner join fills, group by order: VWAP, last fill ts, shares filled
  const rows = ords.flatMap((o, i) => {
    const fs = fl[i] ?? [];
    if (!fs.length) return [];
    const n = fs.reduce((t, f) => t + f.size, 0);
    return [{ o, px: fs.reduce((t, f) => t + f.price * f.size, 0) / n, last: new Date(Math.max(...fs.map((f) => f.ts.getTime()))), n }];
  });
  const props = new Map(pr.filter((x) => x.orderId !== null).map((x) => [x.id, x.priceAtProposal]));
  const trades = rows.map(({ o, px, last }) => ({ approved: o.approval === "user", side: o.side as "BUY" | "SELL", modeledPrice: (o.proposalId && props.get(o.proposalId)) || o.limitPrice, fillPrice: px, at: new Date(last) }));
  const g = gateStats(trades, now);
  const bought = rows.filter((x) => x.o.side === "BUY" && new Date(x.last) >= since).reduce((a, x) => a + x.n, 0);
  const pnl = closed.reduce((t, p) => t + p.realizedPnl, 0);
  return { ...g, avgSlippageC: g.avgSlippage == null ? null : g.avgSlippage * 100, realizedEdge30dC: bought > 0 ? (pnl / bought) * 100 : null, realizedEdge30d: bought > 0 ? pnl / bought : 0 };
}

export async function autonomy(r: ReadDeps) {
  const { db, now } = r;
  const st = await getSettings(db);
  const [mode, mk, f, x, gs, ev, pendingCount, flaggedSets, liveOpen, recon] = await Promise.all([
    currentMode(db),
    db.markets.all(), // distinct categories
    forecastRows(db),
    exposureOf(db, st.bankroll, now()),
    liveGateStats(db, new Date(now())),
    db.autonomyEvents.find("byId", {}, { order: "desc", limit: 50 }),
    db.proposals.count("status", { status: "pending" }),
    db.proposalSets.count("status", { status: "flagged" }),
    db.orders.idsEach("bookStatus", LIVE_OPEN.map((status) => ({ paper: false, status }))).then((x) => x.reduce((t, ids) => t + ids.length, 0)),
    reconStatus(r),
  ]);
  const cats = [...new Set([...mk.flatMap((m) => (m.category ? [m.category] : [])), ...Object.keys(st.overrides)])].sort();
  const a = aggregate(f, () => "all").all;
  return {
    liveOpenOrders: liveOpen, flaggedSets, recon,
    mode, executionEnabled: !!r.exchangeConfigured, exchangeConfigured: !!r.exchangeConfigured, pendingCount, // L2 needs the exchange; L3-L4 refused until phase 7
    categories: cats.map((c) => ({ category: c, override: (st.overrides[c] ?? null) as Mode | null, effective: effectiveMode(mode, st.overrides[c]) })),
    limits: st.limits,
    usage: { totalOpen: x.totalOpen, dailyNotional: x.dailyNotional, dailyRealizedLoss: x.dailyRealizedLoss, byCategory: x.byCategory },
    gates: [
      { gate: "L1->L2" as const, ...gateProgress("L1->L2", { resolved: a?.n ?? 0, brier: a?.brier, marketBrier: a?.marketBrier }) },
      { gate: "L2->L3" as const, ...gateProgress("L2->L3", gs), approvedTrades: gs.approvedLiveTrades, avgSlippageC: gs.avgSlippageC },
      { gate: "L3->L4" as const, ...gateProgress("L3->L4", gs), liveTrades: gs.liveTrades, realizedEdge30dC: gs.realizedEdge30dC },
    ],
    events: ev.map((e) => ({ id: e.id, ts: e.ts.getTime(), fromMode: e.fromMode as Mode, toMode: e.toMode as Mode, scope: e.scope, reason: e.reason, actor: e.actor })),
  };
}

// ---------------------------------------------------------------- proposals (DESIGN 8.1 / 8.7)
/** Pending + sending (soonest expiry first) and the last 10 resolved (newest first). */
export async function proposals(r: ReadDeps) {
  const { db } = r;
  type P = typeof s.proposals.$inferSelect;
  const join = async (ps: P[]) => {
    const M = await marketsById(db, ps.map((p) => p.conditionId));
    return ps.map((p) => { const m = M.get(p.conditionId); return m ? { p, m } : null; }); // inner join markets
  };
  const done = ["sent", "rejected", "expired", "failed"].map((status) => ({ status }));
  const [open, recent] = await Promise.all([
    db.proposals.find("statusExpires", [{ status: "pending" }, { status: "approved" }], { order: "asc" }).then(join).then((xs) => xs.filter(nonNull)),
    // decidedAt desc as Postgres orders it: undecided (null) rows first, then newest decided
    limitJoined(10, async (k) => {
      const [undecided, decided] = await Promise.all([
        db.proposals.find("statusDecided", done, { max: -Infinity, limit: k }),
        db.proposals.find("statusDecided", done, { order: "desc", limit: k }).then((xs) => xs.filter((p) => p.decidedAt !== null)),
      ]);
      return [...undecided, ...decided].slice(0, k);
    }, join),
  ]);
  const ids = [...new Set([...open, ...recent].map((x) => x.p.conditionId))];
  const snaps = ids.length ? await latestSnaps(db, ids) : new Map<string, never>();
  const ords = [...open, ...recent].flatMap((x) => (x.p.orderId ? [x.p.orderId] : []));
  const clob = new Map((await db.orders.getMany([...new Set(ords)])).map((o) => [o.id, { id: o.id, c: o.clobOrderId, a: o.approval }]));
  const row = ({ p, m }: (typeof open)[number]) => {
    const yes = snaps.get(p.conditionId)?.mid ?? null, isYes = p.tokenId === m.yesTokenId, expired = p.status === "expired";
    return {
      id: p.id, conditionId: p.conditionId, question: m.question, thesisId: p.thesisId, side: (isYes ? "YES" : "NO") as Side, orderSide: p.side as "BUY" | "SELL", kind: p.kind,
      shares: p.shares, limitPrice: p.limitPrice, costUsd: p.shares * p.limitPrice, edgeC: p.shares ? (p.expectedProfit / p.shares) * 100 : null, expectedProfitUsd: p.expectedProfit,
      midAtProposal: p.priceAtProposal, midNow: yes == null ? null : isYes ? yes : 1 - yes, createdAt: p.createdAt.getTime(), expiresAt: p.expiresAt.getTime(),
      state: uiState(p.status), reason: expired ? p.error : null, error: expired ? null : p.error, orderId: p.orderId ? (clob.get(p.orderId)?.c ?? null) : null,
      decidedVia: p.decidedVia, fallbackReason: p.fallbackReason, exitReason: p.exitReason, approval: (p.orderId ? (clob.get(p.orderId)?.a ?? null) : null) as "auto" | "user" | null,
    };
  };
  return { pending: open.map(row), recent: recent.map(row), sets: await setViews(db) };
}

// ---------------------------------------------------------------- sets (DESIGN 9.1 / 9.2 / 9.8)
const SET_OPEN = ["pending", "sending", "unwinding"];
const SET_DONE = ["filled", "unwound", "failed", "flagged", "acknowledged", "rejected", "expired"];
/** Open sets (soonest expiry first), every flagged set, and the last 10 resolved. held/suggestedAction only for flagged sets (from booked fills). */
async function setViews(db: Db) {
  const [open, flagged, recent] = await Promise.all([
    db.proposalSets.find("statusExpires", SET_OPEN.map((status) => ({ status })), { order: "asc" }),
    db.proposalSets.find("status", { status: "flagged" }),
    db.proposalSets.find("status", SET_DONE.map((status) => ({ status })), { order: "desc", limit: 10 }), // by createdAt desc
  ]);
  const done = [...new Map([...flagged, ...recent].map((p) => [p.id, p])).values()];
  const all = [...open, ...done];
  if (!all.length) return { pending: [], recent: [] };
  const ids = [...new Set(all.flatMap((p) => p.legs.map((l) => l.conditionId)))];
  const [mk, snaps, ords] = await Promise.all([
    db.markets.getMany(ids),
    latestSnaps(db, ids),
    db.orders.findEach("set", all.map((p) => ({ setId: p.id }))).then((x) => x.flat()),
  ]);
  const fl = (await db.fills.findEach("order", ords.map((o) => ({ orderId: o.id })))).flatMap((fs, i) => fs.map((f) => ({ f, o: ords[i]! }))); // inner join orders
  const M = new Map(mk.map((m) => [m.conditionId, m]));
  const O = new Map(ords.map((o) => [o.idempotencyKey, o]));
  const view = (p: (typeof all)[number]) => {
    const legs = p.legs.map((l, i) => {
      const m = M.get(l.conditionId), o = O.get(`set:${p.id}:${i}`), u = O.get(`set:${p.id}:u${i}`);
      const state = !o ? "queued" : o.status === "sending" ? "sending" : u ? (u.status === "sending" ? "unwinding" : u.status === "filled" ? "unwound" : "held") : orderUi(o.status, 0);
      return { conditionId: l.conditionId, question: m?.question ?? l.conditionId, token: (l.token === m?.yesTokenId ? "YES" : "NO") as Side, capPrice: l.limit, shares: l.shares, costUsd: l.shares * l.limit, state };
    });
    const held = p.status !== "flagged" ? [] : p.legs.flatMap((l, i) => {
      const f = fl.filter((x) => x.o.setId === p.id && x.o.tokenId === l.token);
      const buys = f.filter((x) => x.o.side === "BUY"), bought = buys.reduce((t, x) => t + x.f.size, 0);
      const shares = bought - f.filter((x) => x.o.side === "SELL").reduce((t, x) => t + x.f.size, 0);
      if (!(shares > 1e-6)) return [];
      const sn = snaps.get(l.conditionId), yes = legs[i]!.token === "YES";
      const bidNow = yes ? (sn?.bestBid ?? null) : sn?.bestAsk == null ? null : 1 - sn.bestAsk;
      return [{ conditionId: l.conditionId, question: legs[i]!.question, token: legs[i]!.token, shares, avgFill: buys.reduce((t, x) => t + x.f.price * x.f.size, 0) / bought, bidNow }];
    });
    const unknown = p.status === "flagged" ? ords.filter((o) => o.setId === p.id && ["sending", "unknown", "failed_unknown"].includes(o.status)).length : 0;
    const suggestedAction = p.status !== "flagged" ? null
      : [...(unknown ? [`Check the venue: ${unknown} leg order(s) in unknown state`] : []), ...held.map((h) => `SELL ${+h.shares.toFixed(2)} ${h.token} on Polymarket, bid ${h.bidNow?.toFixed(3) ?? "n/a"}`)].join("; ") || "Check positions on Polymarket";
    return {
      id: p.id, kind: "set" as const, setKind: p.kind as "buy-all" | "sell-all", eventId: p.eventId, state: p.status, shares: p.shares, costUsd: p.totalCost,
      lockedC: p.shares ? (p.edge / p.shares) * 100 : null, expectedProfitUsd: p.edge, createdAt: p.createdAt.getTime(), expiresAt: p.expiresAt.getTime(),
      decidedVia: p.decidedVia, fallbackReason: p.fallbackReason,
      failedLeg: p.failedLeg, error: p.error, legs, held, suggestedAction,
    };
  };
  return { pending: open.map(view), recent: done.map(view) };
}

// ---------------------------------------------------------------- settings + flags
export const settingsGet = (r: Pick<Deps, "db">) => getSettings(r.db);
/** Throws ZodError on invalid input; nothing is saved. */
export const settingsPut = (r: Pick<Deps, "db">, patch: unknown) => putSettings(r.db, patch);

export async function setFlag(r: Pick<Deps, "db">, conditionId: string, flag: { pinned?: boolean; muted?: boolean }) {
  await r.db.marketFlags.upsert({ conditionId, ...flag }, flag); // ON CONFLICT (condition_id) DO UPDATE: only the given flags change
  memoClear("watch:");
}

// ---------------------------------------------------------------- pod detail (live runs view)
/** One pod: stage, cost totals, agent rows with captured tool calls, evidence, thesis (null until sizing wrote one), per-pod budget knobs. */
export async function podDetail(r: ReadDeps, podId: string) {
  const { db } = r;
  const p = await db.pods.get(podId);
  if (!p) return null;
  const [mkt, agents, ev, th, st] = await Promise.all([
    db.markets.get(p.conditionId), // left join
    db.agentRuns.find("pod", { podId }), // by id asc
    db.evidence.find("pod", { podId }), // by id asc
    db.theses.find("pod", { podId }, { order: "desc", limit: 1 }),
    getSettings(db),
  ]);
  const row = { p, q: mkt?.question ?? null };
  type U = { inputTokens: number; outputTokens: number; costUsd: number };
  const u = (a: (typeof agents)[number]) => (a.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }) as U;
  const t = th[0];
  return {
    pod: {
      id: p.id, conditionId: p.conditionId, question: row.q, status: p.status, stage: p.stage, trigger: p.trigger, profileId: p.profileId, steering: p.steering,
      startedAt: p.startedAt.getTime(), cancelRequestedAt: p.cancelRequestedAt?.getTime() ?? null, costSandboxS: p.costSandboxS,
      cost: { inputTokens: agents.reduce((n, a) => n + u(a).inputTokens, 0), outputTokens: agents.reduce((n, a) => n + u(a).outputTokens, 0), costUsd: agents.reduce((n, a) => n + u(a).costUsd, 0) },
    },
    agents: agents.map((a) => ({
      id: a.id, role: a.role, model: a.model, status: a.status, output: a.outputJson, usage: a.usage as U | null, durationS: a.durationS,
      startedAt: a.startedAt?.getTime() ?? null, finishedAt: a.finishedAt?.getTime() ?? null, toolCalls: a.toolCalls ?? [],
    })),
    evidence: ev.map((e) => ({ id: e.id, role: e.agentRole, claim: e.claim, quote: e.quote, url: e.url, direction: e.direction, publishedAt: e.publishedAt?.getTime() ?? null, retrievedAt: e.retrievedAt.getTime() })),
    thesis: t ? { id: t.id, createdAt: t.createdAt.getTime(), expiresAt: t.expiresAt?.getTime() ?? null, side: t.side as Side, pHat: t.pHat, c: t.c, pPost: t.pPost, edgeC: t.edgeC, sizeUsd: t.sizeUsd, rAnn: t.rAnn, rank: t.rank, catalysts: t.catalysts, killCriteria: t.killCriteria, ...dt(t) } : null,
    budget: st.budget, // per-pod knobs: sandboxTimeoutMin, exaCallsPerPod, plus the daily caps
  };
}

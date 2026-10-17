import { aggregate, effectiveMode, gateProgress, realizedEdge, reliabilityBins, type Mode, type Side, type Tier, type WatchCore } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { currentMode } from "./autonomy";
import { categoryConfidence, forecastRows } from "./calib";
import { DAY, dbReady, defaultNow, envExchange, type Deps } from "./deps";
import { liveFilled, orderUi, uiState } from "./live";
import { LIVE_OPEN, exposureOf } from "./paper";
import { latestScreens, latestSnaps, shortlist, type StructDetail } from "./screen";
import { getSettings, putSettings } from "./settings";
import { reconStatus } from "./sync";

/** Everything the API needs for reads. */
export type ReadDeps = Pick<Deps, "db" | "now"> & { exchangeConfigured?: boolean };
export const readDeps = async (): Promise<ReadDeps> => ({ db: await dbReady(), now: defaultNow, exchangeConfigured: envExchange() !== null });

type Th = typeof s.theses.$inferSelect;
type ThDetail = { thesis?: string; pYes?: number; pMidYes?: number; k?: number; e?: number; shares?: number; payoff?: number; expectedProfit?: number; capped?: boolean; judgeConfidence?: number; trigger?: string; model?: string };
const dt = (t: Th) => (t.detail ?? {}) as ThDetail;

const latestTheses = async (db: Db, ids?: string[]) => {
  const rows = await db.select().from(s.theses).where(ids ? inArray(s.theses.conditionId, ids) : undefined).orderBy(desc(s.theses.createdAt));
  const m = new Map<string, Th>();
  for (const t of rows) if (!m.has(t.conditionId)) m.set(t.conditionId, t);
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

export async function watchlist(r: ReadDeps, tab: "small-cap" | "size", sort?: WatchSort, o?: { includeMuted?: boolean; limit?: number }): Promise<WatchlistRow[]>;
export async function watchlist(r: ReadDeps, tab: "structural", sort?: WatchSort, o?: { includeMuted?: boolean; limit?: number }): Promise<StructuralRow[]>;
export async function watchlist(r: ReadDeps, tab: Tier | "structural", sort: WatchSort = "rank", o: { includeMuted?: boolean; limit?: number } = {}): Promise<WatchlistRow[] | StructuralRow[]> {
  const { db } = r, now = r.now(), limit = o.limit ?? 100;
  const screens = await latestScreens(db);
  const ids = screens.map((x) => x.conditionId);
  if (!ids.length) return [];
  const [mk, flags, snaps, ths, sl, run] = await Promise.all([
    db.select().from(s.markets).where(inArray(s.markets.conditionId, ids)),
    db.select().from(s.marketFlags),
    latestSnaps(db, ids),
    latestTheses(db, ids),
    shortlist(db, 20),
    db.select({ c: s.pods.conditionId }).from(s.pods).where(eq(s.pods.status, "running")),
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

// ---------------------------------------------------------------- market detail
export async function marketDetail(r: ReadDeps, conditionId: string) {
  const { db } = r, now = r.now();
  const m = (await db.select().from(s.markets).where(eq(s.markets.conditionId, conditionId)))[0];
  if (!m) return null;
  const [snap, ths, flag, scr, hist, pos, pods] = await Promise.all([
    latestSnaps(db, [conditionId]).then((x) => x.get(conditionId) ?? null),
    db.select().from(s.theses).where(eq(s.theses.conditionId, conditionId)).orderBy(desc(s.theses.createdAt)),
    db.select().from(s.marketFlags).where(eq(s.marketFlags.conditionId, conditionId)).then((x) => x[0]),
    db.select().from(s.screens).where(eq(s.screens.conditionId, conditionId)).orderBy(desc(s.screens.ts)).limit(1).then((x) => x[0] ?? null),
    db.select({ ts: s.snapshots.ts, mid: s.snapshots.mid }).from(s.snapshots).where(eq(s.snapshots.conditionId, conditionId)).orderBy(desc(s.snapshots.ts)).limit(500),
    db.select().from(s.positions).where(and(eq(s.positions.conditionId, conditionId), eq(s.positions.paper, true))).orderBy(desc(s.positions.id)),
    db.select().from(s.pods).where(eq(s.pods.conditionId, conditionId)).orderBy(desc(s.pods.startedAt)),
  ]);
  const t = ths[0] ?? null;
  const podId = t?.podId ?? pods.find((p) => p.status === "done")?.id;
  const [evidence, agents] = podId
    ? await Promise.all([
        db.select().from(s.evidence).where(eq(s.evidence.podId, podId)),
        db.select().from(s.agentRuns).where(eq(s.agentRuns.podId, podId)).orderBy(asc(s.agentRuns.id)),
      ])
    : [[], []];
  return {
    market: {
      conditionId, question: m.question, rules: m.rules, category: m.category, tags: m.tags, eventId: m.eventId, negRiskGroup: m.negRiskGroup,
      endDate: m.endDate?.getTime() ?? null, daysLeft: ((m.endDate?.getTime() ?? now) - now) / DAY, feeRate: m.feeRate, status: m.status,
      yesTokenId: m.yesTokenId, noTokenId: m.noTokenId, pinned: !!flag?.pinned, muted: !!flag?.muted,
    },
    snapshot: snap && { ts: snap.ts.getTime(), mid: snap.mid, bestBid: snap.bestBid, bestAsk: snap.bestAsk, depth5cUsd: snap.depth5cUsd, vol24h: snap.vol24h, oi: snap.oi, top10Share: snap.top10Share, bids: snap.book?.bids ?? [], asks: snap.book?.asks ?? [], netFlow: snap.book?.netFlow ?? 0 },
    history: hist.map((h) => ({ ts: h.ts.getTime(), mid: h.mid })).reverse(),
    screen: scr && { ts: scr.ts.getTime(), R: scr.r, I: scr.i, L: scr.l, T: scr.t, C: scr.c, priority: scr.priority, tier: scr.tier, structural: scr.structuralDetail },
    thesis: t && {
      id: t.id, podId: t.podId, createdAt: t.createdAt.getTime(), expiresAt: t.expiresAt?.getTime() ?? null, side: t.side as Side, pHat: t.pHat, c: t.c, pPost: t.pPost,
      edgeC: t.edgeC, sizeUsd: t.sizeUsd, rAnn: t.rAnn, rank: t.rank, catalysts: t.catalysts, killCriteria: t.killCriteria, ...dt(t),
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
  const st = await getSettings(db);
  const pods = await db.select({ p: s.pods, q: s.markets.question }).from(s.pods).leftJoin(s.markets, eq(s.markets.conditionId, s.pods.conditionId)).orderBy(desc(s.pods.startedAt)).limit(50);
  const runs = pods.length ? await db.select().from(s.agentRuns).where(inArray(s.agentRuns.podId, pods.map((x) => x.p.id))).orderBy(asc(s.agentRuns.id)) : [];
  type U = { inputTokens: number; outputTokens: number; costUsd: number };
  const usage = (a: (typeof runs)[number]) => (a.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }) as U;
  const day = new Date(now).toISOString().slice(0, 10);
  const sp = (await db.select().from(s.spend).where(eq(s.spend.day, day)))[0];
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
      id: p.id, conditionId: p.conditionId, question: q, trigger: p.trigger, status: p.status, startedAt: p.startedAt.getTime(), costSandboxS: p.costSandboxS,
      agents: runs.filter((a) => a.podId === p.id).map((a) => ({ role: a.role, model: a.model, status: a.status, durationS: a.durationS, usage: usage(a), output: a.outputJson })),
    })),
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
  const pos = await db.select({ p: s.positions, m: s.markets }).from(s.positions).innerJoin(s.markets, eq(s.markets.conditionId, s.positions.conditionId)).where(eq(s.positions.paper, true)).orderBy(desc(s.positions.id));
  const ids = [...new Set(pos.map((x) => x.p.conditionId))];
  const [snaps, outs, ords] = ids.length
    ? await Promise.all([
        latestSnaps(db, ids),
        db.select().from(s.outcomes).where(inArray(s.outcomes.conditionId, ids)),
        db.select().from(s.orders).where(inArray(s.orders.conditionId, ids)),
      ])
    : [new Map<string, never>(), [], []];
  const FT = ords.length ? await db.select().from(s.fills).where(inArray(s.fills.orderId, ords.map((o) => o.id))) : [];
  const fillTs = new Map(FT.map((f) => [f.orderId, f.ts.getTime()]));
  const resolvedAt = new Map(outs.map((o) => [o.conditionId, o.resolvedAt.getTime()]));
  const OT = new Map((ords.length ? await db.select().from(s.theses).where(inArray(s.theses.id, [...new Set(ords.map((o) => o.thesisId))])) : []).map((x) => [x.id, x]));
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
  const fl = await db.select({ f: s.fills, o: s.orders, q: s.markets.question }).from(s.fills).innerJoin(s.orders, eq(s.orders.id, s.fills.orderId)).innerJoin(s.markets, eq(s.markets.conditionId, s.orders.conditionId)).where(eq(s.orders.modeAtSend, "L1")).orderBy(desc(s.fills.id)).limit(200);
  const T = new Map((await db.select().from(s.theses).where(inArray(s.theses.id, [...new Set(fl.map((x) => x.o.thesisId))]))).map((t) => [t.id, t]));
  const fills = fl.map(({ f, o, q }) => {
    const t = T.get(o.thesisId), k = t ? (dt(t).k ?? null) : null;
    return {
      ts: f.ts.getTime(), conditionId: o.conditionId, question: q, side: (t?.side ?? null) as Side | null, price: f.price, size: f.size, fee: f.fee, modeledK: k,
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
  const pos = await db.select({ p: s.positions, m: s.markets }).from(s.positions).innerJoin(s.markets, eq(s.markets.conditionId, s.positions.conditionId))
    .where(and(eq(s.positions.paper, false), isNull(s.positions.closedAt))).orderBy(desc(s.positions.id));
  const snaps = pos.length ? await latestSnaps(db, [...new Set(pos.map((x) => x.p.conditionId))]) : new Map<string, never>();
  const positions = pos.map(({ p, m }) => {
    const yes = snaps.get(p.conditionId)?.mid ?? null, isYes = p.tokenId === m.yesTokenId;
    const mark = yes == null ? p.avgCost : isYes ? yes : 1 - yes;
    return { conditionId: p.conditionId, question: m.question, tokenId: p.tokenId, outcome: (isYes ? "YES" : "NO") as "YES" | "NO", shares: p.size, avgPrice: p.avgCost, markPrice: mark, unrealizedUsd: p.size * (mark - p.avgCost) };
  });
  const filled = await liveFilled(db);
  const ords = await db.select({ o: s.orders, q: s.markets.question }).from(s.orders).innerJoin(s.markets, eq(s.markets.conditionId, s.orders.conditionId))
    .where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN))).orderBy(desc(s.orders.createdAt));
  const openOrders = ords.map(({ o, q }) => ({
    orderId: o.clobOrderId ?? o.id, conditionId: o.conditionId, question: q, side: o.side as "BUY" | "SELL", price: o.limitPrice, shares: o.size,
    filledShares: filled.get(o.id) ?? 0, status: orderUi(o.status, filled.get(o.id) ?? 0), expiresAt: o.expiresAt?.getTime() ?? null,
  }));
  const fl = await db.select({ f: s.fills, o: s.orders, q: s.markets.question }).from(s.fills).innerJoin(s.orders, eq(s.orders.id, s.fills.orderId))
    .innerJoin(s.markets, eq(s.markets.conditionId, s.orders.conditionId)).where(eq(s.fills.paper, false)).orderBy(desc(s.fills.ts), desc(s.fills.id)).limit(50);
  const fills = fl.map(({ f, o, q }) => ({ tradeId: f.tradeId ?? String(f.id), conditionId: o.conditionId, question: q, side: o.side as "BUY" | "SELL", price: f.price, shares: f.size, feeUsd: f.fee, at: f.ts.getTime() }));
  return { positions, openOrders, fills, recon: await reconStatus(r) };
}

// ---------------------------------------------------------------- autonomy
export async function autonomy(r: ReadDeps) {
  const { db, now } = r;
  const st = await getSettings(db);
  const mode = await currentMode(db);
  const cats = [...new Set([...(await db.selectDistinct({ c: s.markets.category }).from(s.markets)).flatMap((x) => (x.c ? [x.c] : [])), ...Object.keys(st.overrides)])].sort();
  const f = await forecastRows(db);
  const a = aggregate(f, () => "all").all;
  const x = await exposureOf(db, st.bankroll, now());
  const ev = await db.select().from(s.autonomyEvents).orderBy(desc(s.autonomyEvents.id)).limit(50);
  const pend = await db.select({ id: s.proposals.id }).from(s.proposals).where(eq(s.proposals.status, "pending"));
  const liveOpen = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN)));
  return {
    liveOpenOrders: liveOpen.length, recon: await reconStatus(r),
    mode, executionEnabled: !!r.exchangeConfigured, exchangeConfigured: !!r.exchangeConfigured, pendingCount: pend.length, // L2 needs the exchange; L3-L4 refused until phase 7
    categories: cats.map((c) => ({ category: c, override: (st.overrides[c] ?? null) as Mode | null, effective: effectiveMode(mode, st.overrides[c]) })),
    limits: st.limits,
    usage: { totalOpen: x.totalOpen, dailyNotional: x.dailyNotional, dailyRealizedLoss: x.dailyRealizedLoss, byCategory: x.byCategory },
    gates: [
      { gate: "L1->L2" as const, ...gateProgress("L1->L2", { resolved: a?.n ?? 0, brier: a?.brier, marketBrier: a?.marketBrier }) },
      { gate: "L2->L3" as const, ...gateProgress("L2->L3", {}) },
      { gate: "L3->L4" as const, ...gateProgress("L3->L4", {}) },
    ],
    events: ev.map((e) => ({ id: e.id, ts: e.ts.getTime(), fromMode: e.fromMode as Mode, toMode: e.toMode as Mode, scope: e.scope, reason: e.reason, actor: e.actor })),
  };
}

// ---------------------------------------------------------------- proposals (DESIGN 8.1 / 8.7)
/** Pending + sending (soonest expiry first) and the last 10 resolved (newest first). */
export async function proposals(r: ReadDeps) {
  const { db } = r;
  const q = () => db.select({ p: s.proposals, m: s.markets }).from(s.proposals).innerJoin(s.markets, eq(s.markets.conditionId, s.proposals.conditionId));
  const [open, recent] = await Promise.all([
    q().where(inArray(s.proposals.status, ["pending", "approved"])).orderBy(asc(s.proposals.expiresAt)),
    q().where(inArray(s.proposals.status, ["sent", "rejected", "expired", "failed"])).orderBy(desc(s.proposals.decidedAt)).limit(10),
  ]);
  const ids = [...new Set([...open, ...recent].map((x) => x.p.conditionId))];
  const snaps = ids.length ? await latestSnaps(db, ids) : new Map<string, never>();
  const ords = [...open, ...recent].flatMap((x) => (x.p.orderId ? [x.p.orderId] : []));
  const clob = new Map((ords.length ? await db.select({ id: s.orders.id, c: s.orders.clobOrderId }).from(s.orders).where(inArray(s.orders.id, ords)) : []).map((o) => [o.id, o.c]));
  const row = ({ p, m }: (typeof open)[number]) => {
    const yes = snaps.get(p.conditionId)?.mid ?? null, isYes = p.tokenId === m.yesTokenId, expired = p.status === "expired";
    return {
      id: p.id, conditionId: p.conditionId, question: m.question, thesisId: p.thesisId, side: (isYes ? "YES" : "NO") as Side, orderSide: p.side as "BUY" | "SELL", kind: p.kind,
      shares: p.shares, limitPrice: p.limitPrice, costUsd: p.shares * p.limitPrice, edgeC: p.shares ? (p.expectedProfit / p.shares) * 100 : null, expectedProfitUsd: p.expectedProfit,
      midAtProposal: p.priceAtProposal, midNow: yes == null ? null : isYes ? yes : 1 - yes, createdAt: p.createdAt.getTime(), expiresAt: p.expiresAt.getTime(),
      state: uiState(p.status), reason: expired ? p.error : null, error: expired ? null : p.error, orderId: p.orderId ? (clob.get(p.orderId) ?? null) : null,
    };
  };
  return { pending: open.map(row), recent: recent.map(row) };
}

// ---------------------------------------------------------------- settings + flags
export const settingsGet = (r: Pick<Deps, "db">) => getSettings(r.db);
/** Throws ZodError on invalid input; nothing is saved. */
export const settingsPut = (r: Pick<Deps, "db">, patch: unknown) => putSettings(r.db, patch);

export async function setFlag(r: Pick<Deps, "db">, conditionId: string, flag: { pinned?: boolean; muted?: boolean }) {
  await r.db.insert(s.marketFlags).values({ conditionId, ...flag }).onConflictDoUpdate({ target: s.marketFlags.conditionId, set: flag });
}

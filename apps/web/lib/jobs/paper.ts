import { applyFill, checkOrder, effectiveMode, feeRateFor, mirror, paperFill, pass1, qualifies, settle, sizeTrade, crowd, type Exposure, type Limits, type Market, type Mode, type WatchCore } from "@pm/core";
import { schema as s } from "@pm/db";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { currentMode, downgradeOn } from "./autonomy";
import { DAY, feeOf, toMarket, toSnap, today, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

// No candidates => the only snapshots are the watchlist cron (*/5, may be empty) and scope=all (:05/:35): allow >= 2x that cadence before calling the feed dead.
const NO_CAND_STALE_MS = 15 * 60_000;
const TICK = 0.01; // ponytail: default tick; per-market tick size not stored
const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;

/** Open positions of the paper or live book with their market (for exposure + settlement). */
export const openBook = (db: Deps["db"], paper: boolean) =>
  db.select({ p: s.positions, m: s.markets }).from(s.positions).innerJoin(s.markets, eq(s.markets.conditionId, s.positions.conditionId))
    .where(and(eq(s.positions.paper, paper), isNull(s.positions.closedAt)));
export const openPaper = (db: Deps["db"]) => openBook(db, true);
/** Live order statuses that may still hold or become a position. */
export const LIVE_OPEN = ["sending", "live", "matched", "unknown"];

type MarketRow = typeof s.markets.$inferSelect;
type SnapRow = typeof s.snapshots.$inferSelect;
type ThesisRow = typeof s.theses.$inferSelect;
export const eventOf = (m: MarketRow) => m.negRiskGroup ?? m.eventId ?? m.conditionId; // neg-risk group = one event

export function addExposure(x: Exposure, m: MarketRow, usd: number) {
  const bump = (o: Record<string, number>, k: string) => void (o[k] = (o[k] ?? 0) + usd);
  bump(x.byMarket, m.conditionId);
  bump(x.byEvent, eventOf(m));
  bump(x.byCategory, m.category ?? "other");
  x.totalOpen += usd;
}

/** Open paper (default) or live book at cost + today's notional and realized loss, in the shape core checkOrder wants. Books never mix. */
export async function exposureOf(db: Deps["db"], bankroll: number, now: number, paper = true): Promise<Exposure> {
  const x: Exposure = { bankroll, byMarket: {}, byEvent: {}, byCategory: {}, totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 };
  for (const { p, m } of await openBook(db, paper)) addExposure(x, m, p.size * p.avgCost);
  const dayStart = new Date(`${today(now)}T00:00:00Z`);
  if (paper) for (const f of await db.select().from(s.fills).where(and(eq(s.fills.paper, true), gte(s.fills.ts, dayStart)))) x.dailyNotional += f.price * f.size;
  else {
    // ponytail: open live orders count at limit x size on top of positions; once fill sync (P4) books a position it must move the order out of LIVE_OPEN, else it double-counts (over-count = fail-safe)
    const ords = await db.select({ o: s.orders, m: s.markets }).from(s.orders).innerJoin(s.markets, eq(s.markets.conditionId, s.orders.conditionId))
      .where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN)));
    for (const { o, m } of ords) addExposure(x, m, o.size * o.limitPrice);
    // "daily max notional sent": approved/sent proposals decided today
    for (const p of await db.select().from(s.proposals).where(and(inArray(s.proposals.status, ["approved", "sent"]), gte(s.proposals.decidedAt, dayStart))))
      x.dailyNotional += p.shares * p.limitPrice;
  }
  for (const p of await db.select().from(s.positions).where(and(eq(s.positions.paper, paper), isNotNull(s.positions.closedAt), gte(s.positions.closedAt, dayStart))))
    x.dailyRealizedLoss -= p.realizedPnl; // net: same-day gains offset losses
  x.dailyRealizedLoss = Math.max(0, x.dailyRealizedLoss);
  return x;
}

/** Newest live thesis per active market whose effective mode is `mode`, minus `held` markets; best rank first. */
export async function candidates(d: Deps, mode: Mode, held: Set<string>) {
  const { db, settings: st } = d, now = d.now();
  const ths = await db.select().from(s.theses).where(and(gt(s.theses.expiresAt, new Date(now)), gt(s.theses.sizeUsd, 0))).orderBy(desc(s.theses.createdAt));
  const mk = new Map((await db.select().from(s.markets)).map((m) => [m.conditionId, m]));
  const seen = new Set<string>();
  const cands = ths.filter((t) => {
    const m = mk.get(t.conditionId);
    if (seen.has(t.conditionId)) return false;
    seen.add(t.conditionId);
    return !!m && m.status === "active" && !held.has(t.conditionId) && effectiveMode(mode, st.overrides[m.category ?? ""]) === mode;
  }).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  return { cands, mk };
}

/** Re-size a thesis on its fresh snapshot and run the SPEC qualifying checks. A flipped side means the thesis is dead. */
export function assess(d: Deps, t: ThesisRow, row: MarketRow, snap: SnapRow | undefined, now: number):
  { ok: false; failed: string[] } | { ok: true; m: Market; sz: WatchCore; snap: SnapRow & { book: NonNullable<SnapRow["book"]>; mid: number } } {
  const st = d.settings;
  const dt = (t.detail ?? {}) as { pYes?: number; capped?: boolean };
  if (!snap?.book || snap.mid == null || dt.pYes == null) return { ok: false, failed: ["NO_BOOK"] };
  const m = toMarket(row);
  const cr = crowd({ top10Share: snap.top10Share ?? 0, netFlow: snap.book.netFlow, skew: 0 });
  const sz = sizeTrade({
    bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid, pHat: dt.pYes, c: t.c, daysLeft: (m.endDate - now) / DAY,
    feeRate: feeOf(m), crowdC: cr.c, crowdSide: cr.side, settings: st,
  });
  if (!sz || sz.side !== t.side || sz.sizeUsd <= 0) return { ok: false, failed: ["NO_EDGE_NOW"] };
  const q = qualifies(
    { edge: sz.e, confidence: t.c, disagreementCapTripped: !!dt.capped },
    { categoryThreshold: st.limits.categoryThreshold, bookAgeMs: now - snap.ts.getTime(), pass1: pass1(m, toSnap(snap), st, now).ok },
  );
  if (!q.ok) return { ok: false, failed: q.failed };
  return { ok: true, m, sz, snap: snap as SnapRow & { book: NonNullable<SnapRow["book"]>; mid: number } };
}

/** Auto-downgrade inputs shared by paper (L1) and propose (L2). Stale = newest snapshot anywhere (feed down), not one candidate; skipped on a DB with no snapshots yet. `x` must be the book's own exposure. */
export async function downgradeSignals(d: Deps, x: Exposure, nCands: number) {
  const now = d.now();
  const last = ((await d.db.select({ ts: max(s.snapshots.ts) }).from(s.snapshots)) as [{ ts: Date | null }])[0].ts;
  return {
    dailyLossHit: d.settings.limits.dailyLoss > 0 && !(x.dailyRealizedLoss < d.settings.limits.dailyLoss), // 0 = disabled
    bookStaleMs: !last ? 0 : nCands || now - last.getTime() > NO_CAND_STALE_MS ? now - last.getTime() : 0,
  };
}

/** L1: settle resolved paper positions, then fill every qualifying thesis at k(S) against a fresh book. */
export async function paperBook(d: Deps) {
  return withLock(d, "paper", 5 * 60_000, async () => {
    const { db, settings: st } = d, now = d.now();
    const mode = await currentMode(db);

    // 1. settle (runs in any mode: positions that exist must not rot)
    const outs = new Map((await db.select().from(s.outcomes)).map((o) => [o.conditionId, o.result]));
    let settled = 0;
    for (const { p, m } of await openPaper(db)) {
      const res = outs.get(p.conditionId);
      if (!res) continue;
      const won = (res === "YES") === (p.tokenId === m.yesTokenId) ? 1 : 0;
      const end = settle({ shares: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl }, won);
      await db.update(s.positions).set({ realizedPnl: end.realizedPnl, closedAt: new Date(now) }).where(eq(s.positions.id, p.id));
      settled++;
    }
    const res = { mode, settled, candidates: 0, filled: 0, rejected: {} as Record<string, number>, violations: [] as { conditionId: string; rules: string[] }[] };
    if (mode !== "L1") return res; // L0 observes; L2+ is unreachable this build

    // 2. candidates: newest live thesis per market, no open paper position
    const { cands, mk } = await candidates(d, "L1", new Set((await openPaper(db)).map((x) => x.p.conditionId)));
    res.candidates = cands.length;
    if (cands.length) await takeSnapshots(d, cands.map((t) => t.conditionId)); // "fresh book (< 60 s at order time)"

    // 3. auto-downgrades
    const x = await exposureOf(db, st.bankroll, now);
    const dg = await downgradeOn(d, await downgradeSignals(d, x, cands.length));
    if (dg) return { ...res, mode: dg };
    if (!cands.length) return res;
    const snaps = await latestSnaps(db, cands.map((t) => t.conditionId));
    const L: Limits = { ...st.limits };

    const reject = (r: string) => void (res.rejected[r] = (res.rejected[r] ?? 0) + 1);
    for (const t of cands) {
      const row = mk.get(t.conditionId)!;
      const a = assess(d, t, row, snaps.get(t.conditionId), now);
      if (!a.ok) { a.failed.forEach(reject); continue; }
      const { m, sz: now1, snap } = a;

      const chk = checkOrder({ sizeUsd: now1.sizeUsd, marketId: m.conditionId, eventId: eventOf(row), category: row.category ?? "other" }, x, L);
      const tokenId = t.side === "YES" ? row.yesTokenId : row.noTokenId;
      const f = paperFill(t.side === "YES" ? snap.book.asks : mirror(snap.book.bids), now1.sizeUsd, feeRateFor(m.category, m.feeRate).rate);
      if (!tokenId || !f.complete || f.shares <= 0) { reject("THIN_BOOK"); continue; }

      const rules = chk.violations.map((v) => v.rule);
      if ((await currentMode(db)) !== "L1") { reject("MODE_CHANGED"); break; } // killed mid-run
      const key = `${t.id}:paper`;
      if ((await db.select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.idempotencyKey, key))).length) { reject("ALREADY_FILLED"); continue; }
      // Neon HTTP has no tx: position -> fill -> order (idempotency key) last, so a crash never leaves an order without its position
      const orderId = id("ord");
      const pos = applyFill({ shares: 0, avgCost: 0, realizedPnl: 0 }, { side: "buy", shares: f.shares, price: f.avgPrice, fee: f.fee });
      await db.insert(s.positions).values({ conditionId: t.conditionId, tokenId, size: pos.shares, avgCost: pos.avgCost, realizedPnl: 0, openedAt: new Date(now), paper: true });
      await db.insert(s.fills).values({ orderId, ts: new Date(now), price: f.avgPrice, size: f.shares, fee: f.fee });
      await db.insert(s.orders).values({
        id: orderId, thesisId: t.id, idempotencyKey: key, conditionId: t.conditionId, tokenId, side: "BUY", limitPrice: Math.round(Math.ceil(f.avgPrice / TICK - 1e-9) * TICK * 1e6) / 1e6, size: f.shares,
        modeAtSend: "L1", approval: null, status: rules.length ? `paper_filled!${rules.join(",")}` : "paper_filled", expiresAt: t.expiresAt,
      });
      addExposure(x, row, f.filled);
      x.dailyNotional += f.filled;
      res.filled++;
      if (rules.length) res.violations.push({ conditionId: t.conditionId, rules }); // L1 records; L2+ would reject
      publish("paper.fill", { conditionId: t.conditionId, side: t.side, sizeUsd: f.filled, avgPrice: f.avgPrice });
    }
    return res;
  });
}

/** Close one open paper position at the current best bid (latest snapshot). null = unknown/closed position. */
export async function closePaperPosition(d: Deps, positionId: number) {
  const row = (await openPaper(d.db)).find((x) => x.p.id === positionId);
  if (!row) return null;
  const { p, m } = row;
  const snap = (await latestSnaps(d.db, [p.conditionId])).get(p.conditionId);
  const levels = snap?.book ? (p.tokenId === m.yesTokenId ? snap.book.bids : mirror(snap.book.asks)) : [];
  if (!levels.length) return { reason: "NO_BOOK" };
  const bid = Math.max(...levels.map((l) => l.price));
  const end = applyFill({ shares: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl }, { side: "sell", shares: p.size, price: bid, fee: 0 }); // ponytail: top-of-book, no depth walk or fee
  await d.db.update(s.positions).set({ realizedPnl: end.realizedPnl, closedAt: new Date(d.now()) }).where(eq(s.positions.id, p.id));
  publish("paper.close", { conditionId: p.conditionId, realizedPnl: end.realizedPnl });
  return { ok: true as const, realizedPnl: end.realizedPnl };
}

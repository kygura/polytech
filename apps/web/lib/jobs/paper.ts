import { applyFill, checkOrder, effectiveMode, feeRateFor, mirror, paperFill, pass1, qualifies, settle, sizeTrade, crowd, type Exposure, type Limits } from "@pm/core";
import { schema as s } from "@pm/db";
import { and, desc, eq, gt, gte, isNotNull, isNull } from "drizzle-orm";
import { currentMode } from "./autonomy";
import { DAY, feeOf, toMarket, toSnap, today, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;

/** Open paper positions with their market (for exposure + settlement). */
export const openPaper = (db: Deps["db"]) =>
  db.select({ p: s.positions, m: s.markets }).from(s.positions).innerJoin(s.markets, eq(s.markets.conditionId, s.positions.conditionId))
    .where(and(eq(s.positions.paper, true), isNull(s.positions.closedAt)));

type MarketRow = typeof s.markets.$inferSelect;
const eventOf = (m: MarketRow) => m.negRiskGroup ?? m.eventId ?? m.conditionId; // neg-risk group = one event

export function addExposure(x: Exposure, m: MarketRow, usd: number) {
  const bump = (o: Record<string, number>, k: string) => void (o[k] = (o[k] ?? 0) + usd);
  bump(x.byMarket, m.conditionId);
  bump(x.byEvent, eventOf(m));
  bump(x.byCategory, m.category ?? "other");
  x.totalOpen += usd;
}

/** Open paper book at cost + today's notional and realized loss, in the shape core checkOrder wants. */
export async function exposureOf(db: Deps["db"], bankroll: number, now: number): Promise<Exposure> {
  const x: Exposure = { bankroll, byMarket: {}, byEvent: {}, byCategory: {}, totalOpen: 0, dailyNotional: 0, dailyRealizedLoss: 0 };
  for (const { p, m } of await openPaper(db)) addExposure(x, m, p.size * p.avgCost);
  const dayStart = new Date(`${today(now)}T00:00:00Z`);
  for (const f of await db.select().from(s.fills).where(gte(s.fills.ts, dayStart))) x.dailyNotional += f.price * f.size;
  for (const p of await db.select().from(s.positions).where(and(eq(s.positions.paper, true), isNotNull(s.positions.closedAt), gte(s.positions.closedAt, dayStart))))
    if (p.realizedPnl < 0) x.dailyRealizedLoss -= p.realizedPnl;
  return x;
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
    const ths = await db.select().from(s.theses).where(and(gt(s.theses.expiresAt, new Date(now)), gt(s.theses.sizeUsd, 0))).orderBy(desc(s.theses.createdAt));
    const open = await openPaper(db);
    const held = new Set(open.map((x) => x.p.conditionId));
    const mk = new Map((await db.select().from(s.markets)).map((m) => [m.conditionId, m]));
    const seen = new Set<string>();
    const cands = ths.filter((t) => {
      const m = mk.get(t.conditionId);
      if (seen.has(t.conditionId)) return false;
      seen.add(t.conditionId);
      return !!m && m.status === "active" && !held.has(t.conditionId) && effectiveMode(mode, st.overrides[m.category ?? ""]) === "L1";
    }).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    res.candidates = cands.length;
    if (!cands.length) return res;

    await takeSnapshots(d, cands.map((t) => t.conditionId)); // "fresh book (< 60 s at order time)"
    const snaps = await latestSnaps(db, cands.map((t) => t.conditionId));

    // 3. exposure at cost, updated as we fill
    const x = await exposureOf(db, st.bankroll, now);
    const L: Limits = { ...st.limits };

    const reject = (r: string) => void (res.rejected[r] = (res.rejected[r] ?? 0) + 1);
    for (const t of cands) {
      const row = mk.get(t.conditionId)!, snap = snaps.get(t.conditionId);
      const dt = (t.detail ?? {}) as { pYes?: number; capped?: boolean };
      if (!snap?.book || snap.mid == null || dt.pYes == null) { reject("NO_BOOK"); continue; }
      const m = toMarket(row);
      const cr = crowd({ top10Share: snap.top10Share ?? 0, netFlow: snap.book.netFlow, skew: 0 });
      const now1 = sizeTrade({ // re-size on the fresh book; a flipped side means the thesis is dead
        bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid, pHat: dt.pYes, c: t.c, daysLeft: (m.endDate - now) / DAY,
        feeRate: feeOf(m), crowdC: cr.c, crowdSide: cr.side, settings: st,
      });
      if (!now1 || now1.side !== t.side || now1.sizeUsd <= 0) { reject("NO_EDGE_NOW"); continue; }
      const q = qualifies(
        { edge: now1.e, confidence: t.c, disagreementCapTripped: !!dt.capped },
        { categoryThreshold: st.limits.categoryThreshold, bookAgeMs: now - snap.ts.getTime(), pass1: pass1(m, toSnap(snap), st, now).ok },
      );
      if (!q.ok) { q.failed.forEach(reject); continue; }

      const chk = checkOrder({ sizeUsd: now1.sizeUsd, marketId: m.conditionId, eventId: eventOf(row), category: row.category ?? "other" }, x, L);
      const tokenId = t.side === "YES" ? row.yesTokenId : row.noTokenId;
      const f = paperFill(t.side === "YES" ? snap.book.asks : mirror(snap.book.bids), now1.sizeUsd, feeRateFor(m.category, m.feeRate).rate);
      if (!tokenId || !f.complete || f.shares <= 0) { reject("THIN_BOOK"); continue; }

      const rules = chk.violations.map((v) => v.rule);
      const orderId = id("ord");
      const ins = await db.insert(s.orders).values({
        id: orderId, thesisId: t.id, idempotencyKey: `${t.id}:paper`, conditionId: t.conditionId, tokenId, side: "BUY", limitPrice: f.avgPrice, size: f.shares,
        modeAtSend: "L1", approval: null, status: rules.length ? `paper_filled!${rules.join(",")}` : "paper_filled", expiresAt: t.expiresAt,
      }).onConflictDoNothing().returning({ id: s.orders.id });
      if (!ins.length) { reject("ALREADY_FILLED"); continue; }
      await db.insert(s.fills).values({ orderId, ts: new Date(now), price: f.avgPrice, size: f.shares, fee: f.fee });
      const pos = applyFill({ shares: 0, avgCost: 0, realizedPnl: 0 }, { side: "buy", shares: f.shares, price: f.avgPrice, fee: f.fee });
      await db.insert(s.positions).values({ conditionId: t.conditionId, tokenId, size: pos.shares, avgCost: pos.avgCost, realizedPnl: 0, openedAt: new Date(now), paper: true });
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

import { applyFill, checkOrder, effectiveMode, feeRateFor, mirror, paperFill, pass1, qualifies, settle, sizeTrade, crowd, type Exposure, type Limits, type Market, type Mode, type WatchCore } from "@pm/core";
import { schema as s } from "@pm/db";
import { currentMode, downgradeOn } from "./autonomy";
import { DAY, feeExpOf, feeOf, toMarket, toSnap, today, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

// No candidates => the only snapshots are the watchlist cron (*/5, may be empty) and scope=all (:05/:35): allow >= 2x that cadence before calling the feed dead.
const NO_CAND_STALE_MS = 15 * 60_000;
const TICK = 0.01; // ponytail: default tick; per-market tick size not stored
const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;

type PositionRow = typeof s.positions.$inferSelect;
type MarketRow = typeof s.markets.$inferSelect;

/** Rows joined to their market (INNER JOIN: rows whose market is missing are dropped), in input order. */
async function withMarket<R extends { conditionId: string }, K extends string>(db: Deps["db"], rows: R[], as: K): Promise<({ [P in K]: R } & { m: MarketRow })[]> {
  if (!rows.length) return [];
  const mk = new Map((await db.markets.getMany([...new Set(rows.map((r) => r.conditionId))])).map((m) => [m.conditionId, m]));
  return rows.flatMap((r) => { const m = mk.get(r.conditionId); return m ? [{ [as]: r, m } as { [P in K]: R } & { m: MarketRow }] : []; });
}

/** Open positions of the paper or live book with their market (for exposure + settlement), by id. */
export const openBook = async (db: Deps["db"], paper: boolean): Promise<{ p: PositionRow; m: MarketRow }[]> =>
  withMarket(db, (await db.positions.find("open", { paper })).filter((p) => p.closedAt === null), "p");
export const openPaper = (db: Deps["db"]) => openBook(db, true);
/** Live order statuses that may still hold or become a position. */
export const LIVE_OPEN = ["sending", "live", "matched", "unknown"];

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
  const dayStart = new Date(`${today(now)}T00:00:00Z`), ds = dayStart.getTime();
  const [book, fills, ords, props, closed] = await Promise.all([
    openBook(db, paper),
    paper ? db.fills.find("book", { paper: true }, { min: dayStart }) : [],
    // ponytail: open live orders count at limit x size on top of positions; once fill sync (P4) books a position it must move the order out of LIVE_OPEN, else it double-counts (over-count = fail-safe)
    paper ? [] : db.orders.find("bookStatus", LIVE_OPEN.map((status) => ({ paper: false, status }))).then((os) => withMarket(db, os, "o")),
    // "daily max notional sent": approved/sent proposals decided today (null decidedAt sorts as -inf, outside the range)
    paper ? [] : db.proposals.find("statusDecided", [{ status: "approved" }, { status: "sent" }], { min: dayStart }),
    db.positions.find("closed", { paper }, { min: dayStart }),
  ]);
  for (const { p, m } of book) addExposure(x, m, p.size * p.avgCost);
  for (const f of fills) x.dailyNotional += f.price * f.size;
  for (const { o, m } of ords) addExposure(x, m, o.size * o.limitPrice);
  for (const p of props) if (p.kind === "entry" && p.decidedAt !== null && p.decidedAt.getTime() >= ds) x.dailyNotional += p.shares * p.limitPrice;
  for (const p of closed) if (p.closedAt !== null && p.closedAt.getTime() >= ds) x.dailyRealizedLoss -= p.realizedPnl; // net: same-day gains offset losses
  x.dailyRealizedLoss = Math.max(0, x.dailyRealizedLoss);
  return x;
}

/** Newest live thesis per active market whose effective mode (under global `top`) is `mode`, minus `held` markets; best rank first. */
export async function candidates(d: Deps, mode: Mode, held: Set<string>, top = mode) {
  const { db, settings: st } = d, now = d.now();
  // expiresAt > now AND sizeUsd > 0 ORDER BY createdAt DESC (ties by id desc)
  const ths = (await db.theses.find("byExpiry", {}, { gt: now })).filter((t) => t.expiresAt !== null && t.expiresAt.getTime() > now && t.sizeUsd > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const mk = new Map((await db.markets.getMany([...new Set(ths.map((t) => t.conditionId))])).map((m) => [m.conditionId, m]));
  const seen = new Set<string>();
  const cands = ths.filter((t) => {
    const m = mk.get(t.conditionId);
    if (seen.has(t.conditionId)) return false;
    seen.add(t.conditionId);
    return !!m && m.status === "active" && !held.has(t.conditionId) && effectiveMode(top, st.overrides[m.category ?? ""]) === mode;
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
    feeRate: feeOf(m), feeExponent: feeExpOf(m), crowdC: cr.c, crowdSide: cr.side, settings: st,
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
  const [a, b] = await Promise.all([d.db.snapshots.first("byTs", {}, { order: "desc" }), d.db.marketLatest.first("byTs", {}, { order: "desc" })]); // max(ts) of each
  const last = a?.ts && b?.ts ? (a.ts > b.ts ? a.ts : b.ts) : (a?.ts ?? b?.ts ?? null); // market_latest moves every run; history rows skip unchanged books
  return {
    dailyLossHit: d.settings.limits.dailyLoss > 0 && !(x.dailyRealizedLoss < d.settings.limits.dailyLoss), // 0 = disabled
    bookStaleMs: !last ? 0 : nCands || now - last.getTime() > NO_CAND_STALE_MS ? now - last.getTime() : 0,
  };
}

/** Close open positions of the paper or live book whose market resolved; realized PnL = payout - cost. */
export async function settleResolved(d: Pick<Deps, "db" | "now">, paper: boolean) {
  const { db } = d, now = d.now();
  const book = await openBook(db, paper);
  if (!book.length) return 0;
  const outs = new Map((await db.outcomes.getMany([...new Set(book.map((x) => x.p.conditionId))])).map((o) => [o.conditionId, o.result]));
  const yes = new Map(book.map(({ p, m }) => [p.id, m.yesTokenId]));
  const due = book.filter(({ p }) => outs.has(p.conditionId)).map(({ p }) => p.id);
  // one CAS per position (batched): computed from the current row, and only while it is still open, so a concurrent settle/close cannot close it twice
  return (await db.positions.updateMany(due, (p) => {
    const res = outs.get(p.conditionId);
    if (p.closedAt !== null || !res) return null;
    const won = (res === "YES") === (p.tokenId === yes.get(p.id)) ? 1 : 0;
    const end = settle({ shares: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl }, won);
    return { realizedPnl: end.realizedPnl, closedAt: new Date(now) };
  })).length;
}

/** L1: settle resolved paper positions, then fill every qualifying thesis at k(S) against a fresh book. */
export async function paperBook(d: Deps) {
  return withLock(d, "paper", 5 * 60_000, async () => {
    const { db, settings: st } = d, now = d.now();
    const mode = await currentMode(db);

    // 1. settle (runs in any mode: positions that exist must not rot)
    const settled = await settleResolved(d, true);
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
      const f = paperFill(t.side === "YES" ? snap.book.asks : mirror(snap.book.bids), now1.sizeUsd, feeRateFor(m.category, m.feeRate).rate, feeExpOf(m));
      if (!tokenId || !f.complete || f.shares <= 0) { reject("THIN_BOOK"); continue; }

      const rules = chk.violations.map((v) => v.rule);
      if ((await currentMode(db)) !== "L1") { reject("MODE_CHANGED"); break; } // killed mid-run
      const key = `${t.id}:paper`;
      if (await db.orders.byUnique("idempotencyKey", { idempotencyKey: key })) { reject("ALREADY_FILLED"); continue; }
      // position, fill and order (unique idempotency key) commit together: a lost race on the key leaves no orphan position or fill
      const orderId = id("ord");
      const pos = applyFill({ shares: 0, avgCost: 0, realizedPnl: 0 }, { side: "buy", shares: f.shares, price: f.avgPrice, fee: f.fee });
      await db.tx(async (tx) => {
        await tx.positions.insert({ conditionId: t.conditionId, tokenId, size: pos.shares, avgCost: pos.avgCost, realizedPnl: 0, openedAt: new Date(now), paper: true });
        await tx.fills.insert({ orderId, ts: new Date(now), price: f.avgPrice, size: f.shares, fee: f.fee });
        await tx.orders.insert({
          id: orderId, thesisId: t.id, idempotencyKey: key, conditionId: t.conditionId, tokenId, side: "BUY", limitPrice: Math.round(Math.ceil(f.avgPrice / TICK - 1e-9) * TICK * 1e6) / 1e6, size: f.shares,
          modeAtSend: "L1", approval: null, status: rules.length ? `paper_filled!${rules.join(",")}` : "paper_filled", expiresAt: t.expiresAt,
        });
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
  const p = await d.db.positions.get(positionId);
  if (!p || !p.paper || p.closedAt !== null) return null;
  const m = await d.db.markets.get(p.conditionId); // inner join: no market => not in the open book
  if (!m) return null;
  const snap = (await latestSnaps(d.db, [p.conditionId])).get(p.conditionId);
  const levels = snap?.book ? (p.tokenId === m.yesTokenId ? snap.book.bids : mirror(snap.book.asks)) : [];
  if (!levels.length) return { reason: "NO_BOOK" };
  const bid = Math.max(...levels.map((l) => l.price));
  // CAS: computed from the current row and only while it is still open (a double click or a racing settle/sellOut cannot close it twice)
  const at = new Date(d.now());
  const closed = await d.db.positions.update(p.id, (cur) => {
    if (cur.closedAt !== null || !cur.paper) return null;
    const end = applyFill({ shares: cur.size, avgCost: cur.avgCost, realizedPnl: cur.realizedPnl }, { side: "sell", shares: cur.size, price: bid, fee: 0 }); // ponytail: top-of-book, no depth walk or fee
    return { realizedPnl: end.realizedPnl, closedAt: at };
  });
  if (!closed) return null;
  publish("paper.close", { conditionId: p.conditionId, realizedPnl: closed.realizedPnl });
  return { ok: true as const, realizedPnl: closed.realizedPnl };
}

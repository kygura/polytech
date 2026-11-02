import { applyFill, feeRateFor, mirror, paperFill } from "@pm/core";
import { schema as s } from "@pm/db";
import { feeExpOf, isOpenStatus, toMarket, type Deps } from "./deps";
import { publish } from "./events";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

export type PaperOrder = {
  conditionId: string;
  outcome: "YES" | "NO";
  side: "BUY" | "SELL";
  /** BUY: dollars to spend. */
  usd?: number;
  /** SELL: shares to sell (from the open paper position on this outcome). */
  shares?: number;
  /** Optional limit in 0..1: BUY fills only at or under it, SELL only at or over it. What does not fill now rests until it does or is cancelled. */
  limit?: number;
  /** Stop in 0..1: BUY triggers when the outcome's midpoint rises to it, SELL when it falls to it; then it fills at market. Rests until then. */
  stop?: number;
};
export type PaperWorking = { id: string; kind: "limit" | "stop"; side: "BUY" | "SELL"; outcome: "YES" | "NO"; limit: number | null; stop: number | null; usd: number | null; shares: number | null };
export type PaperOrderResult =
  | { ok: true; side: "BUY" | "SELL"; outcome: "YES" | "NO"; shares: number; avgPrice: number; fee: number; usd: number; partial: boolean; realizedPnl?: number; working?: PaperWorking }
  | { ok: false; error: string };

type Lv = { price: number; size: number };
type Row = typeof s.paperOrders.$inferSelect;
type Book = { bids: Lv[]; asks: Lv[] };
type Leg = { conditionId: string; outcome: "YES" | "NO"; side: "BUY" | "SELL"; tokenId: string; limit?: number | null };

const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;
const fail = (error: string): PaperOrderResult => ({ ok: false, error });
const DUST_USD = 0.01, DUST_SH = 0.01; // a remainder under this is done, not left resting
const pct = (p: number) => `${Math.round(p * 1000) / 10}¢`;

/** Sell `shares` into bids (best first): shares sold and average price. */
export function sellFill(bids: Lv[], shares: number, feeRate = 0, feeExponent = 1) {
  let left = shares, got = 0;
  for (const b of [...bids].sort((x, y) => y.price - x.price)) {
    if (left <= 1e-9) break;
    const take = Math.min(b.size, left);
    got += take * b.price;
    left -= take;
  }
  const sold = shares - Math.max(left, 0), avgPrice = sold ? got / sold : 0;
  return { shares: sold, avgPrice, complete: left <= 1e-9, fee: feeRate * Math.pow(avgPrice * (1 - avgPrice), feeExponent) * sold };
}

/** A resting BUY at `limit` is the maker: it fills at its own price, no fee, for as many shares as the asks at or under it offer. */
export function restingBuy(asks: Lv[], usd: number, limit: number) {
  const depth = asks.filter((a) => a.price <= limit + 1e-9).reduce((t, a) => t + a.size, 0);
  const shares = Math.min(depth, usd / limit);
  return { shares, avgPrice: limit, fee: 0, filled: shares * limit };
}

/** A resting SELL at `limit`: fills at its own price, no fee, against the bids at or over it. */
export function restingSell(bids: Lv[], shares: number, limit: number) {
  const depth = bids.filter((b) => b.price >= limit - 1e-9).reduce((t, b) => t + b.size, 0);
  return { shares: Math.min(depth, shares), avgPrice: limit, fee: 0 };
}

/** A BUY stop fires once the price rises to it, a SELL stop once it falls to it. */
export const stopHit = (side: "BUY" | "SELL", stop: number, mid: number) => (side === "BUY" ? mid >= stop - 1e-9 : mid <= stop + 1e-9);

/** The outcome's side of the YES book: NO asks are the mirrored YES bids. */
const sideBook = (b: Book, outcome: "YES" | "NO"): Book => (outcome === "YES" ? b : { bids: mirror(b.asks), asks: mirror(b.bids) });
const outcomeMid = (mid: number | null, outcome: "YES" | "NO") => (mid == null ? null : outcome === "YES" ? mid : 1 - mid);

/** Open paper positions on one token, oldest (lowest id) first. (paper, tokenId) index, closed rows dropped in code. */
const openPositions = async (d: Deps, tokenId: string) =>
  d.db.positions.find("openToken", { paper: true, tokenId });

/** Add a fill to the newest open position on this outcome, else open one. */
async function buyInto(d: Deps, leg: Leg, shares: number, price: number, fee: number, now: number) {
  const into = (await openPositions(d, leg.tokenId)).at(-1);
  // CAS read-modify-write from the current row (a concurrent fill on the same position both land); closed in the meantime => open a new one
  const added = into && await d.db.positions.update(into.id, (cur) => {
    if (cur.closedAt !== null) return null;
    const pos = applyFill({ shares: cur.size, avgCost: cur.avgCost, realizedPnl: cur.realizedPnl }, { side: "buy", shares, price, fee });
    return { size: pos.shares, avgCost: pos.avgCost };
  });
  if (!added) {
    const pos = applyFill({ shares: 0, avgCost: 0, realizedPnl: 0 }, { side: "buy", shares, price, fee });
    await d.db.positions.insert({ conditionId: leg.conditionId, tokenId: leg.tokenId, size: pos.shares, avgCost: pos.avgCost, realizedPnl: 0, openedAt: new Date(now), paper: true });
  }
  await record(d, leg, shares, price, fee, now);
}

/** Take a sale out of the open positions, oldest first; fee charged on the first leg. Returns the realized P&L. */
async function sellOut(d: Deps, leg: Leg, shares: number, price: number, fee: number, now: number) {
  const ids = (await openPositions(d, leg.tokenId)).map((p) => p.id);
  // one transaction over the FIFO walk: re-reads the rows (versions checked at commit), so a concurrent fill or close cannot be lost
  const pnl = await d.db.tx(async (tx) => {
    let left = shares, pnl = 0, f = fee;
    for (const p of (await tx.positions.getMany(ids)).filter((x) => x.paper && x.closedAt === null && x.tokenId === leg.tokenId)) {
      if (left <= 1e-9) break;
      const take = Math.min(p.size, left);
      const end = applyFill({ shares: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl }, { side: "sell", shares: take, price, fee: f });
      pnl += end.realizedPnl - p.realizedPnl;
      f = 0;
      left -= take;
      await tx.positions.update(p.id, { size: end.shares, realizedPnl: end.realizedPnl, ...(end.shares <= 1e-9 ? { closedAt: new Date(now) } : {}) });
    }
    return pnl;
  });
  await record(d, leg, shares, price, fee, now);
  return pnl;
}

/**
 * A manual paper trade at the live book: a fresh snapshot, then a depth walk (BUY spends `usd` up the asks, SELL hits the bids). No wallet, no
 * exchange call. Books into the same paper positions the L1 autonomy mode uses, so Portfolio > Paper shows both. A limit's unfilled rest and a
 * stop rest in paper_orders; workPaperOrders fills them on later books.
 */
export async function placePaperOrder(d: Deps, o: PaperOrder): Promise<PaperOrderResult> {
  const { db } = d, now = d.now();
  const m = await db.markets.get(o.conditionId);
  if (!m) return fail("market not found");
  if (!isOpenStatus(m.status) || m.status === "not_accepting") return fail("market is not taking orders");
  const tokenId = o.outcome === "YES" ? m.yesTokenId : m.noTokenId;
  if (!tokenId) return fail("market has no token for this outcome");
  if (o.stop != null && o.limit != null) return fail("a stop order fills at market: leave the limit out");
  if (o.side === "BUY" && !(o.usd && o.usd > 0)) return fail("enter an amount in dollars");
  if (o.side === "SELL" && !(o.shares && o.shares > 0)) return fail("enter how many shares to sell");

  await takeSnapshots(d, [o.conditionId]).catch((e) => console.error("paper order: snapshot failed", e)); // fill against the book as it is now
  const snap = (await latestSnaps(db, [o.conditionId])).get(o.conditionId);
  if (!snap?.book) return fail("no order book for this market");
  const { asks, bids } = sideBook(snap.book, o.outcome);
  const mk = toMarket(m), feeRate = feeRateFor(mk.category, mk.feeRate).rate, feeExp = feeExpOf(mk);
  const leg: Leg = { conditionId: o.conditionId, outcome: o.outcome, side: o.side, tokenId, limit: o.limit };

  // Working SELLs do not reserve shares, so a stop-loss and a take-profit can both cover one position; whichever fills first wins, the other
  // is cancelled when nothing is left to sell.
  const held = o.side === "SELL" ? (await openPositions(d, tokenId)).reduce((t, p) => t + p.size, 0) : 0;
  if (o.side === "SELL" && held <= 1e-9) return fail(`you hold no paper ${o.outcome} shares`);
  const rest = (kind: "limit" | "stop", usd: number | null, shares: number | null): Promise<PaperWorking> => {
    const w: PaperWorking = { id: id("pord"), kind, side: o.side, outcome: o.outcome, limit: o.limit ?? null, stop: o.stop ?? null, usd, shares };
    return db.paperOrders.insert({
      id: w.id, conditionId: o.conditionId, tokenId, outcome: o.outcome, side: o.side, kind, limitPrice: w.limit, stopPrice: w.stop, usd, shares, createdAt: new Date(now), bookTs: snap.ts,
    }).then(() => (publish("paper.order", { conditionId: o.conditionId, id: w.id, status: "working" }), w));
  };

  if (o.stop != null) {
    const mid = outcomeMid(snap.mid, o.outcome);
    if (mid == null) return fail("no price to set the stop against");
    if (stopHit(o.side, o.stop, mid)) return fail(o.side === "BUY" ? `a buy stop must be above the price now (${pct(mid)})` : `a sell stop must be below the price now (${pct(mid)})`);
    const w = await rest("stop", o.side === "BUY" ? o.usd! : null, o.side === "SELL" ? Math.min(o.shares!, held) : null);
    return { ok: true, side: o.side, outcome: o.outcome, shares: 0, avgPrice: 0, fee: 0, usd: 0, partial: false, working: w };
  }

  if (o.side === "BUY") {
    const f = paperFill(asks.filter((l) => o.limit == null || l.price <= o.limit + 1e-9), o.usd!, feeRate, feeExp);
    if (f.shares <= 0 && o.limit == null) return fail("no sellers on the book");
    if (f.shares > 0) await buyInto(d, leg, f.shares, f.avgPrice, f.fee, now);
    const left = o.usd! - f.filled;
    const working = o.limit != null && left >= DUST_USD ? await rest("limit", left, null) : undefined;
    return { ok: true, side: "BUY", outcome: o.outcome, shares: f.shares, avgPrice: f.avgPrice, fee: f.fee, usd: f.filled, partial: !f.complete, ...(working ? { working } : {}) };
  }

  const want = Math.min(o.shares!, held);
  const f = sellFill(bids.filter((l) => o.limit == null || l.price >= o.limit - 1e-9), want, feeRate, feeExp);
  if (f.shares <= 0 && o.limit == null) return fail("no buyers on the book");
  const pnl = f.shares > 0 ? await sellOut(d, leg, f.shares, f.avgPrice, f.fee, now) : 0;
  const left = want - f.shares;
  const working = o.limit != null && left >= DUST_SH ? await rest("limit", null, left) : undefined;
  return { ok: true, side: "SELL", outcome: o.outcome, shares: f.shares, avgPrice: f.avgPrice, fee: f.fee, usd: f.shares * f.avgPrice, partial: !f.complete || f.shares < o.shares! - 1e-9, realizedPnl: pnl, ...(working ? { working } : {}) };
}

/**
 * Works the resting paper orders against each market's latest book: a stop whose price is reached fires and fills at market (taker, fee); a
 * resting limit fills at its own price (maker, no fee) for the depth that crosses it. Each book counts once per order (bookTs).
 * `snapshot`: take fresh books first (off the snapshot job, which already has them).
 */
export async function workPaperOrders(d: Deps, ids?: string[], o: { snapshot?: boolean } = {}) {
  const { db } = d, now = d.now();
  const res = { working: 0, triggered: 0, filled: 0, cancelled: 0 };
  // status = 'working' [AND conditionId IN ids] ORDER BY createdAt ASC (partitions merged by createdAt, ties by id)
  const rows = ids
    ? await db.paperOrders.find("statusCond", [...new Set(ids)].map((conditionId) => ({ status: "working", conditionId })))
    : await db.paperOrders.find("status", { status: "working" });
  if (!rows.length) return res;
  const conds = [...new Set(rows.map((r) => r.conditionId))];
  if (o.snapshot) await takeSnapshots(d, conds).catch((e) => console.error("paper orders: snapshot failed", e));
  const [mrows, snaps] = await Promise.all([db.markets.getMany(conds), latestSnaps(db, conds)]);
  const mk = new Map(mrows.map((m) => [m.conditionId, m]));
  const close = (r: Row, status: "filled" | "cancelled", reason: string | null, extra: Partial<Row> = {}) =>
    db.paperOrders.update(r.id, { ...extra, status, reason, closedAt: new Date(now) })
      .then(() => publish("paper.order", { conditionId: r.conditionId, id: r.id, status }));

  for (const r of rows) {
    const m = mk.get(r.conditionId);
    if (!m || !isOpenStatus(m.status)) { await close(r, "cancelled", "market closed"); res.cancelled++; continue; }
    const snap = snaps.get(r.conditionId);
    if (m.status === "not_accepting" || !snap?.book || (r.bookTs && snap.ts.getTime() <= r.bookTs.getTime())) { res.working++; continue; }
    const { asks, bids } = sideBook(snap.book, r.outcome as "YES" | "NO");
    const leg: Leg = { conditionId: r.conditionId, outcome: r.outcome as "YES" | "NO", side: r.side as "BUY" | "SELL", tokenId: r.tokenId, limit: r.limitPrice };
    const seen = { bookTs: snap.ts };

    let taker = false;
    if (r.kind === "stop") {
      if (!r.triggeredAt) {
        const mid = outcomeMid(snap.mid, leg.outcome);
        if (mid == null || !stopHit(leg.side, r.stopPrice!, mid)) { await db.paperOrders.update(r.id, seen); res.working++; continue; }
        await db.paperOrders.update(r.id, { triggeredAt: new Date(now) });
        res.triggered++;
      }
      taker = true; // fired: a market order until it is filled
    }
    const mm = toMarket(m), feeRate = feeRateFor(mm.category, mm.feeRate).rate, feeExp = feeExpOf(mm);

    if (leg.side === "BUY") {
      const left = r.usd ?? 0;
      const f = taker ? paperFill(asks, left, feeRate, feeExp) : restingBuy(asks, left, r.limitPrice!);
      if (f.shares > 0) await buyInto(d, leg, f.shares, f.avgPrice, f.fee, now);
      const usd = left - f.filled, filledShares = r.filledShares + f.shares;
      if (usd < DUST_USD) { await close(r, "filled", null, { usd: 0, filledShares, ...seen }); res.filled++; }
      else { await db.paperOrders.update(r.id, { usd, filledShares, ...seen }); res.working++; }
      continue;
    }

    const held = (await openPositions(d, r.tokenId)).reduce((t, p) => t + p.size, 0);
    if (held <= 1e-9) { await close(r, "cancelled", "no shares left to sell"); res.cancelled++; continue; }
    const want = Math.min(r.shares ?? 0, held);
    const f = taker ? sellFill(bids, want, feeRate, feeExp) : restingSell(bids, want, r.limitPrice!);
    if (f.shares > 0) await sellOut(d, leg, f.shares, f.avgPrice, f.fee, now);
    const shares = want - f.shares, filledShares = r.filledShares + f.shares;
    if (shares < DUST_SH) { await close(r, "filled", null, { shares: 0, filledShares, ...seen }); res.filled++; }
    else { await db.paperOrders.update(r.id, { shares, filledShares, ...seen }); res.working++; }
  }
  return res;
}

/** Markets with a working paper order: the watchlist snapshot keeps their books fresh. */
export const workingPaperIds = async (d: Pick<Deps, "db">) =>
  (await d.db.paperOrders.distinct("workingCond")).filter((c): c is string => c !== null);

/** Cancel one working paper order. false = unknown or no longer working. */
export async function cancelPaperOrder(d: Deps, orderId: string) {
  const at = new Date(d.now());
  const row = await d.db.paperOrders.update(orderId, (r) => (r.status === "working" ? { status: "cancelled", reason: "cancelled by you", closedAt: at } : null)); // CAS working -> cancelled
  if (row) publish("paper.order", { conditionId: row.conditionId, id: orderId, status: "cancelled" });
  return row !== null;
}

/** Working paper orders of one market (or all), then the 20 newest closed ones. */
export async function listPaperOrders(d: Deps, conditionId?: string) {
  const po = d.db.paperOrders;
  // closed: ORDER BY closedAt DESC LIMIT 20 with Postgres NULLS FIRST. The index puts null closedAt (-inf) last on desc, so the nulls (first
  // ascending; closed rows always get closedAt, so normally none) are read separately and put in front.
  const closedIx = (o: { order: "asc" | "desc"; limit: number }) => (conditionId ? po.find("closedCond", { conditionId }, o) : po.find("closed", {}, o));
  const [working, newest, oldest] = await Promise.all([
    conditionId ? po.find("statusCond", { status: "working", conditionId }, { order: "desc" }) : po.find("status", { status: "working" }, { order: "desc" }),
    closedIx({ order: "desc", limit: 20 }),
    closedIx({ order: "asc", limit: 20 }),
  ]);
  const closed = [...oldest.filter((r) => r.closedAt === null), ...newest.filter((r) => r.closedAt !== null)].slice(0, 20);
  const out = (r: Row) => ({
    id: r.id, conditionId: r.conditionId, tokenId: r.tokenId, outcome: r.outcome as "YES" | "NO", side: r.side as "BUY" | "SELL", kind: r.kind as "limit" | "stop",
    limit: r.limitPrice, stop: r.stopPrice, usd: r.usd, shares: r.shares, filledShares: r.filledShares, status: r.status as "working" | "filled" | "cancelled", reason: r.reason,
    createdAt: r.createdAt.getTime(), triggeredAt: r.triggeredAt?.getTime() ?? null, closedAt: r.closedAt?.getTime() ?? null,
  });
  return { working: working.map(out), closed: closed.map(out) };
}
export type PaperOrderRow = Awaited<ReturnType<typeof listPaperOrders>>["working"][number];

/** Order + fill rows, so the paper fills table and the journal see manual trades too. */
async function record(d: Deps, leg: Leg, shares: number, price: number, fee: number, now: number) {
  const orderId = id("ord");
  await d.db.tx(async (tx) => { // fill + order commit together (one round trip)
    await tx.fills.insert({ orderId, ts: new Date(now), price, size: shares, fee, paper: true });
    await tx.orders.insert({
      id: orderId, thesisId: "manual", idempotencyKey: `manual:${orderId}`, conditionId: leg.conditionId, tokenId: leg.tokenId, side: leg.side, limitPrice: leg.limit ?? price, size: shares,
      modeAtSend: "manual", approval: "user", status: "paper_filled", paper: true,
    });
  });
  publish("paper.fill", { conditionId: leg.conditionId, side: leg.outcome, sizeUsd: shares * price, avgPrice: price });
}

import { applyFill, feeRateFor, mirror, paperFill } from "@pm/core";
import { schema as s } from "@pm/db";
import { and, asc, eq, isNull } from "drizzle-orm";
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
  /** Optional limit in 0..1: BUY fills only at or under it, SELL only at or over it. */
  limit?: number;
};
export type PaperOrderResult =
  | { ok: true; side: "BUY" | "SELL"; outcome: "YES" | "NO"; shares: number; avgPrice: number; fee: number; usd: number; partial: boolean; realizedPnl?: number }
  | { ok: false; error: string };

const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 12)}`;
const fail = (error: string): PaperOrderResult => ({ ok: false, error });

/** Sell `shares` into bids (best first): shares sold and average price. */
export function sellFill(bids: { price: number; size: number }[], shares: number, feeRate = 0, feeExponent = 1) {
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

/**
 * A manual paper trade at the live book: a fresh snapshot, then a depth walk (BUY spends `usd` up the asks, SELL hits the bids). No wallet, no
 * exchange call. Books into the same paper positions the L1 autonomy mode uses, so Portfolio > Paper shows both.
 */
export async function placePaperOrder(d: Deps, o: PaperOrder): Promise<PaperOrderResult> {
  const { db } = d, now = d.now();
  const m = (await db.select().from(s.markets).where(eq(s.markets.conditionId, o.conditionId)))[0];
  if (!m) return fail("market not found");
  if (!isOpenStatus(m.status) || m.status === "not_accepting") return fail("market is not taking orders");
  const tokenId = o.outcome === "YES" ? m.yesTokenId : m.noTokenId;
  if (!tokenId) return fail("market has no token for this outcome");

  await takeSnapshots(d, [o.conditionId]).catch((e) => console.error("paper order: snapshot failed", e)); // fill against the book as it is now
  const book = (await latestSnaps(db, [o.conditionId])).get(o.conditionId)?.book;
  if (!book) return fail("no order book for this market");
  const mk = toMarket(m), feeRate = feeRateFor(mk.category, mk.feeRate).rate, feeExp = feeExpOf(mk);
  const open = await db.select().from(s.positions)
    .where(and(eq(s.positions.paper, true), eq(s.positions.tokenId, tokenId), isNull(s.positions.closedAt))).orderBy(asc(s.positions.id));

  if (o.side === "BUY") {
    if (!(o.usd && o.usd > 0)) return fail("enter an amount in dollars");
    const asks = (o.outcome === "YES" ? book.asks : mirror(book.bids)).filter((l) => o.limit == null || l.price <= o.limit + 1e-9);
    const f = paperFill(asks, o.usd, feeRate, feeExp);
    if (f.shares <= 0) return fail(o.limit == null ? "no sellers on the book" : "no sellers at or under your limit");
    const into = open.at(-1); // add to the newest open position on this outcome, else open one
    const pos = applyFill(into ? { shares: into.size, avgCost: into.avgCost, realizedPnl: into.realizedPnl } : { shares: 0, avgCost: 0, realizedPnl: 0 }, { side: "buy", shares: f.shares, price: f.avgPrice, fee: f.fee });
    if (into) await db.update(s.positions).set({ size: pos.shares, avgCost: pos.avgCost }).where(eq(s.positions.id, into.id));
    else await db.insert(s.positions).values({ conditionId: o.conditionId, tokenId, size: pos.shares, avgCost: pos.avgCost, realizedPnl: 0, openedAt: new Date(now), paper: true });
    await record(d, o, tokenId, f.shares, f.avgPrice, f.fee, now);
    return { ok: true, side: "BUY", outcome: o.outcome, shares: f.shares, avgPrice: f.avgPrice, fee: f.fee, usd: f.filled, partial: !f.complete };
  }

  const held = open.reduce((t, p) => t + p.size, 0);
  if (!(o.shares && o.shares > 0)) return fail("enter how many shares to sell");
  if (held <= 1e-9) return fail(`you hold no paper ${o.outcome} shares`);
  const bids = (o.outcome === "YES" ? book.bids : mirror(book.asks)).filter((l) => o.limit == null || l.price >= o.limit - 1e-9);
  const f = sellFill(bids, Math.min(o.shares, held), feeRate, feeExp);
  if (f.shares <= 0) return fail(o.limit == null ? "no buyers on the book" : "no buyers at or over your limit");
  // oldest position first; fee charged on the first leg
  let left = f.shares, pnl = 0, fee = f.fee;
  for (const p of open) {
    if (left <= 1e-9) break;
    const take = Math.min(p.size, left);
    const end = applyFill({ shares: p.size, avgCost: p.avgCost, realizedPnl: p.realizedPnl }, { side: "sell", shares: take, price: f.avgPrice, fee });
    pnl += end.realizedPnl - p.realizedPnl;
    fee = 0;
    left -= take;
    await db.update(s.positions).set({ size: end.shares, realizedPnl: end.realizedPnl, ...(end.shares <= 1e-9 ? { closedAt: new Date(now) } : {}) }).where(eq(s.positions.id, p.id));
  }
  await record(d, o, tokenId, f.shares, f.avgPrice, f.fee, now);
  return { ok: true, side: "SELL", outcome: o.outcome, shares: f.shares, avgPrice: f.avgPrice, fee: f.fee, usd: f.shares * f.avgPrice, partial: !f.complete || f.shares < o.shares - 1e-9, realizedPnl: pnl };
}

/** Order + fill rows, so the paper fills table and the journal see manual trades too. */
async function record(d: Deps, o: PaperOrder, tokenId: string, shares: number, price: number, fee: number, now: number) {
  const orderId = id("ord");
  await d.db.insert(s.fills).values({ orderId, ts: new Date(now), price, size: shares, fee, paper: true });
  await d.db.insert(s.orders).values({
    id: orderId, thesisId: "manual", idempotencyKey: `manual:${orderId}`, conditionId: o.conditionId, tokenId, side: o.side, limitPrice: o.limit ?? price, size: shares,
    modeAtSend: "manual", approval: "user", status: "paper_filled", paper: true,
  });
  publish("paper.fill", { conditionId: o.conditionId, side: o.outcome, sizeUsd: shares * price, avgPrice: price });
}

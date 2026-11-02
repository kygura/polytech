import { applyFill, reconcile } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { downgradeOn } from "./autonomy";
import { DAY, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { liveFilled, orderUi } from "./live";
import { LIVE_OPEN, settleResolved } from "./paper";

const MIN = 60_000;
const GRACE = 2 * MIN; // an order missing from open set + trades this young is just API lag
const UNMATCHED = 10 * MIN; // SPEC: unresolved after 10 min => failed_unknown (never resent)
const EPS = 1e-6;
const FAILURES = ["rejected", "unknown", "failed_unknown"];

type Order = typeof s.orders.$inferSelect;
type Trade = Awaited<ReturnType<NonNullable<Deps["exchange"]>["trades"]>>[number];
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Apply one live trade to the open live position of its token (opens it on a buy). A sell beyond the position is skipped; reconcile flags the drift. */
async function applyToPosition(d: Pick<Deps, "db">, o: Order, t: Trade) {
  const pos = (await d.db.positions.find("bookToken", { paper: false, tokenId: t.tokenId })).find((p) => p.closedAt === null) ?? null;
  const fill = { side: t.side === "BUY" ? ("buy" as const) : ("sell" as const), shares: t.shares, price: t.price, fee: t.fee };
  if (!pos && fill.side === "sell") return lateSell(d, t);
  try {
    if (!pos) {
      const next = applyFill({ shares: 0, avgCost: 0, realizedPnl: 0 }, fill);
      await d.db.positions.insert({ conditionId: o.conditionId, tokenId: t.tokenId, size: next.shares, avgCost: next.avgCost, realizedPnl: 0, openedAt: t.at, paper: false });
    } else {
      await d.db.positions.update(pos.id, (cur) => { // applied to the current row (read-modify-write as one compare-and-set)
        const next = applyFill({ shares: cur.size, avgCost: cur.avgCost, realizedPnl: cur.realizedPnl }, fill);
        return { size: next.shares, avgCost: next.avgCost, realizedPnl: next.realizedPnl, closedAt: next.shares <= EPS ? t.at : null };
      });
    }
  } catch {
    /* sell exceeds position */
  }
}

/**
 * A SELL booked after the position was already closed by settlement (it filled before resolution, sync saw it late): settlement credited the payout on the full size,
 * the venue paid the sale price instead, so realized PnL moves by (proceeds - fee - payout). No closed position at/after the fill time => nothing to correct (reconcile flags drift).
 */
async function lateSell(d: Pick<Deps, "db">, t: Trade) {
  const pos = (await d.db.positions.find("bookToken", { paper: false, tokenId: t.tokenId }, { order: "desc" })).find((p) => p.closedAt !== null && p.closedAt.getTime() >= t.at.getTime());
  if (!pos) return;
  const [m, out] = await Promise.all([d.db.markets.get(pos.conditionId), d.db.outcomes.get(pos.conditionId)]);
  if (!m || !out) return; // closed by something other than a resolution
  const payout = (out.result === "YES") === (t.tokenId === m.yesTokenId) ? t.shares : 0;
  const delta = t.price * t.shares - t.fee - payout;
  await d.db.positions.update(pos.id, (cur) => ({ realizedPnl: cur.realizedPnl + delta }));
}

/** 3 newest live orders (since the last mode change) all rejected / unknown / failed => SPEC auto-downgrade. A mode change resets the streak, so re-raising to L2 is not instantly undone by old failures. */
async function orderErrors(d: Pick<Deps, "db">) {
  const ev = await d.db.autonomyEvents.first("scope", { scope: "global" }, { order: "desc" });
  const rows = await d.db.orders.find("book", { paper: false }, { order: "desc", limit: 3, ...(ev ? { gt: ev.ts } : {}) });
  return rows.length === 3 && rows.every((r) => FAILURES.includes(r.status)) ? 3 : 0;
}

/**
 * Pull trades + open orders; book new live fills (unique trade id => idempotent), move orders out of the open statuses, upsert live positions.
 * Order of writes (separate commits, deliberately): fill row first, then position. A crash between them loses a position update, which reconcile flags (fail-safe); the reverse would double-apply on retry.
 */
export async function syncFills(d: Deps) {
  const res = { fills: 0, updated: 0, failedUnknown: 0, error: undefined as string | undefined };
  const ex = d.exchange;
  if (!ex) return res;
  return withLock(d, "sync", 5 * MIN, async () => {
    const { db } = d, now = d.now();
    const last = (await db.fills.first("book", { paper: false }, { order: "desc" }))?.ts ?? null;
    let trades: Trade[], open: Awaited<ReturnType<typeof ex.openOrders>>;
    try {
      [trades, open] = await Promise.all([ex.trades(new Date(last ? last.getTime() - MIN : now - DAY)), ex.openOrders()]); // 1 min overlap; unique trade id absorbs repeats
    } catch (e) {
      return { ...res, error: scrub(e instanceof Error ? e.message : "exchange error").slice(0, 300) };
    }
    const [orders, filled] = await Promise.all([db.orders.find("book", { paper: false }), liveFilled(db)]);
    const claimed = new Set(orders.flatMap((o) => (o.clobOrderId ? [o.clobOrderId] : [])));
    const openIds = new Set(open.map((x) => x.orderId));
    const touched = new Set<string>();
    const emit = (o: Order) => publish("order.updated", { id: o.id, orderId: o.clobOrderId ?? o.id, status: orderUi(o.status, filled.get(o.id) ?? 0, o.size), filledShares: filled.get(o.id) ?? 0 });
    const setStatus = async (o: Order, status: string, extra: Partial<Order> = {}) => {
      Object.assign(o, { status, ...extra });
      await db.orders.update(o.id, { status, ...extra });
      if (status !== "failed_unknown") return;
      const pids = await db.proposals.ids("order", { orderId: o.id });
      for (const p of pids.length ? await db.proposals.updateMany(pids, { status: "failed", error: "ORDER_FAILED_UNKNOWN" }) : [])
        publish("proposal.updated", { id: p.id, state: "failed", error: "ORDER_FAILED_UNKNOWN", orderId: o.clobOrderId ?? o.id });
    };

    // 1. sending/unknown orders without a clob id: attach by unique (token, side, price, shares) match; else 10 min => failed_unknown. Never resend.
    for (const o of orders.filter((x) => !x.clobOrderId && (x.status === "sending" || x.status === "unknown"))) {
      const cands = new Set<string>();
      for (const x of open) if (!claimed.has(x.orderId) && x.tokenId === o.tokenId && x.side === o.side && same(x.price, o.limitPrice) && same(x.shares, o.size)) cands.add(x.orderId);
      for (const t of trades)
        if (!claimed.has(t.orderId) && t.tokenId === o.tokenId && t.side === o.side && t.at >= o.createdAt && t.shares <= o.size + EPS && (o.side === "BUY" ? t.price <= o.limitPrice + EPS : t.price >= o.limitPrice - EPS)) cands.add(t.orderId);
      if (cands.size === 1) {
        const [id] = cands;
        claimed.add(id!);
        await setStatus(o, "live", { clobOrderId: id });
        touched.add(o.id);
      } else if (now - o.createdAt.getTime() >= UNMATCHED) {
        await setStatus(o, "failed_unknown");
        res.failedUnknown++;
        emit(o);
        publish("order.error", { id: o.id, orderId: o.id, error: cands.size ? "AMBIGUOUS_MATCH" : "UNMATCHED" });
      }
    }

    // 2. new fills (any live order with a clob id, so late fills after a kill still book)
    const byClob = new Map(orders.flatMap((o) => (o.clobOrderId ? [[o.clobOrderId, o] as const] : [])));
    for (const t of trades) {
      const o = byClob.get(t.orderId);
      if (!o) continue;
      const ins = await db.fills.insertIfAbsent({ orderId: o.id, ts: t.at, price: t.price, size: t.shares, fee: t.fee, paper: false, tradeId: t.tradeId }); // tradeId unique
      if (!ins) continue;
      await applyToPosition(d, o, t);
      filled.set(o.id, (filled.get(o.id) ?? 0) + t.shares);
      touched.add(o.id);
      res.fills++;
      publish("order.filled", { id: o.id, orderId: o.clobOrderId, conditionId: o.conditionId, price: t.price, shares: t.shares, tradeId: t.tradeId });
    }

    // 3. status of open orders. Partially filled orders stay 'live' (filledShares says partial) so they keep counting in LIVE_OPEN.
    for (const o of orders.filter((x) => LIVE_OPEN.includes(x.status) && x.clobOrderId)) {
      const f = filled.get(o.id) ?? 0, age = now - o.createdAt.getTime();
      let next: string;
      if (f >= o.size - EPS) next = "filled";
      else if (openIds.has(o.clobOrderId!)) next = "live";
      else if (age < GRACE || (o.status === "matched" && f === 0 && age < UNMATCHED)) continue; // not visible yet
      else if (o.status === "matched" && f === 0) next = "failed_unknown"; // venue said matched, no trade ever showed
      else next = o.expiresAt && o.expiresAt.getTime() <= now ? "expired" : "cancelled";
      if (next !== o.status) {
        await setStatus(o, next);
        if (next === "failed_unknown") res.failedUnknown++;
      } else if (!touched.has(o.id)) continue;
      res.updated++;
      emit(o);
    }

    await settleResolved(d, false); // resolved live markets close like paper (realized PnL feeds the daily-loss downgrade)

    // approved proposal whose order reached a terminal status: no permanent "sending"
    const approved = (await db.proposals.find("status", { status: "approved" })).filter((p) => p.orderId !== null);
    const linked = new Map((await db.orders.getMany([...new Set(approved.map((p) => p.orderId!))])).map((o) => [o.id, o.status]));
    for (const p of approved) {
      const st = linked.get(p.orderId!);
      if (st === undefined) continue; // inner join: no order row
      const ok = st === "filled";
      if (!ok && !["cancelled", "expired", "rejected", "failed_unknown"].includes(st)) continue;
      const set = ok ? { status: "sent" } : { status: "failed", error: `ORDER_${st.toUpperCase()}` };
      if (await db.proposals.update(p.id, (r) => (r.status === "approved" ? set : null)))
        publish("proposal.updated", { id: p.id, state: set.status, ...(ok ? {} : { error: set.error }), orderId: p.orderId });
    }

    const n = await orderErrors(d);
    if (n) await downgradeOn(d, { consecutiveOrderErrors: n });
    return res;
  });
}

// ---------------------------------------------------------------- reconcile
/**
 * Ledger definition (documented, deliberately simple):
 *  - base = newest reconciliation row with baseline=true (first run / POST /api/recon/rebaseline insert one: ledger = exchange, positions = exchange).
 *  - usdc ledger = base.usdc + cash flow of live fills newer than base.at (BUY -price*size-fee, SELL +price*size-fee);
 *    position ledger = base.positions + signed live fill shares by token after base.at (BUY +, SELL -). Compared via core reconcile (tol 0.01).
 *  Deposits, withdrawals and settlement payouts are not in the ledger, so they show as a mismatch (halt) until a human rebaselines.
 */
const snapshot = async (ex: NonNullable<Deps["exchange"]>) => {
  const [bal, positions] = await Promise.all([ex.balance(), ex.positions()]);
  return { usdc: bal.usdc, positions };
};
const insertBaseline = async (d: Deps, at: Date, x: { usdc: number; positions: Record<string, number> }, detail: string | null) => {
  await d.db.reconciliations.insert({ at, ok: true, baseline: true, usdcLedger: x.usdc, usdcExchange: x.usdc, positions: x.positions });
  publish("recon.done", { at: at.toISOString(), status: "ok", detail });
};

export async function reconcileJob(d: Deps) {
  const ex = d.exchange;
  if (!ex) return { status: null };
  return withLock(d, "reconcile", 5 * MIN, async () => {
    const { db } = d, at = new Date(d.now());
    const synced = async () => { const r = await syncFills(d); return !("skipped" in r) && !r.error; }; // book what the exchange already shows, or in-flight trades read as drift
    if (!(await synced())) return { status: null }; // stale ledger: judging it would be a false alarm
    const base = await db.reconciliations.first("baseline", {}, { order: "desc" });
    let x = await snapshot(ex);
    if (!base) {
      if (await db.reconciliations.count("byId", {})) { // rows but no baseline (post-migration): a human must rebaseline
        await db.reconciliations.insert({ at, ok: false, usdcLedger: 0, usdcExchange: x.usdc, mismatches: [{ key: NEEDS, ledger: 0, exchange: 0 }] });
        publish("recon.done", { at: at.toISOString(), status: "mismatch", detail: reconDetail([{ key: NEEDS, ledger: 0, exchange: 0 }]) });
        return { status: "mismatch", mismatches: 1 };
      }
      return (await insertBaseline(d, at, x, null), { status: "ok", mismatches: 0 });
    }
    const check = async () => {
      const fs = await db.fills.find("book", { paper: false }, { gt: base.at });
      const os = new Map((await db.orders.getMany([...new Set(fs.map((f) => f.orderId))])).map((o) => [o.id, o]));
      const rows = fs.flatMap((f) => { const o = os.get(f.orderId); return o ? [{ f, side: o.side, tok: o.tokenId }] : []; }); // inner join
      const positions = { ...base.positions };
      for (const { f, side, tok } of rows) positions[tok] = (positions[tok] ?? 0) + (side === "BUY" ? 1 : -1) * f.size;
      const ledger = base.usdcExchange + rows.reduce((t, { f, side }) => t + (side === "BUY" ? -1 : 1) * f.price * f.size - f.fee, 0);
      return { ledger, r: reconcile({ usdc: ledger, positions }, x) };
    };
    let c = await check();
    if (!c.r.ok) { // one retry: a trade may have landed between the sync and the balance read
      if (!(await synced())) return { status: null };
      x = await snapshot(ex);
      c = await check();
    }
    const { ledger, r } = c;
    await db.reconciliations.insert({ at, ok: r.ok, usdcLedger: ledger, usdcExchange: x.usdc, mismatches: r.mismatches });
    const status = r.ok ? "ok" : "mismatch";
    publish("recon.done", { at: at.toISOString(), status, detail: reconDetail(r.mismatches) });
    if (!r.ok) await downgradeOn(d, { balanceMismatch: true });
    return { status, mismatches: r.mismatches.length };
  });
}

/** Accept the current exchange state as the new ledger base (deposit, withdrawal, payout, pre-existing holdings). Clears a recon halt; never changes mode. */
export async function rebaseline(d: Deps, opts: { ack?: boolean } = {}): Promise<{ ok: true; at: string; diff: string } | { ok: false; error: string; code?: "FAILED_UNKNOWN"; diff?: string }> {
  const ex = d.exchange;
  if (!ex) return { ok: false, error: "exchange not configured" };
  const r = await withLock(d, "reconcile", 5 * MIN, async () => {
    const inFlight = () => d.db.orders.first("bookStatus", [{ paper: false, status: "sending" }, { paper: false, status: "unknown" }]);
    const busy = await inFlight();
    if (busy) return { ok: false as const, error: "live orders are still sending or unknown" };
    const sy = await syncFills(d);
    if ("skipped" in sy || sy.error) return { ok: false as const, error: "fill sync unavailable, retry" };
    // matched with no fill booked yet: the venue says it traded, the trade is not visible; a baseline now would swallow it
    const [sending, matched] = await Promise.all([inFlight(), d.db.orders.find("bookStatus", { paper: false, status: "matched" })]);
    const fillIds = await d.db.fills.idsEach("order", matched.map((o) => ({ orderId: o.id })), { limit: 1 });
    const still = sending ?? matched.find((_, i) => !fillIds[i]!.length);
    if (still) return { ok: false as const, error: "live orders are still sending or unknown, or matched without fills" };
    const at = new Date(d.now());
    const snap = await snapshot(ex);
    // exchange vs DB open live positions, per token: shows what the new baseline would swallow
    const mine: Record<string, number> = {};
    for (const p of await d.db.positions.find("open", { paper: false })) mine[p.tokenId] = (mine[p.tokenId] ?? 0) + p.size;
    const diff = reconDetail(Object.keys({ ...mine, ...snap.positions }).flatMap((key) => (Math.abs((mine[key] ?? 0) - (snap.positions[key] ?? 0)) > 0.01 ? [{ key, ledger: mine[key] ?? 0, exchange: snap.positions[key] ?? 0 }] : []))) ?? "none";
    const base = await d.db.reconciliations.first("baseline", {}, { order: "desc" });
    const lost = opts.ack ? 0 : await d.db.orders.count("bookStatus", { paper: false, status: "failed_unknown" }, base ? { gt: base.at } : {});
    if (lost) return { ok: false as const, error: `${lost} live order(s) in failed_unknown since the last baseline: inspect the venue before rebaselining (it would mask a lost order). Position diff exchange vs DB: ${diff}`, code: "FAILED_UNKNOWN" as const, diff };
    await insertBaseline(d, at, snap, "rebaseline");
    return { ok: true as const, at: at.toISOString(), diff };
  });
  return "skipped" in r ? { ok: false, error: "reconcile in progress, retry" } : r;
}

const NEEDS = "NEEDS_REBASELINE";
export const reconDetail = (mm: { key: string; ledger: number; exchange: number }[]) =>
  mm.length ? mm.map((m) => m.key === NEEDS ? "needs rebaseline" : `${m.key.length > 12 ? `${m.key.slice(0, 8)}…` : m.key}: ledger ${+m.ledger.toFixed(4)} vs exchange ${+m.exchange.toFixed(4)}`).join("; ") : null;

/** Latest reconciliation for the UI: late = last run older than 10 min. */
export async function reconStatus(d: Pick<Deps, "db" | "now">) {
  const r = await d.db.reconciliations.first("byId", {}, { order: "desc" });
  if (!r) return { at: null, status: null, detail: null } as { at: string | null; status: "ok" | "mismatch" | "late" | null; detail: string | null };
  const late = d.now() - r.at.getTime() > 10 * MIN;
  return { at: r.at.toISOString(), status: (!r.ok ? "mismatch" : late ? "late" : "ok") as "ok" | "mismatch" | "late", detail: reconDetail(r.mismatches) };
}

import { applyFill, reconcile } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { and, desc, eq, gt, inArray, isNull, max } from "drizzle-orm";
import { downgradeOn } from "./autonomy";
import { DAY, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { liveFilled, orderUi } from "./live";
import { LIVE_OPEN } from "./paper";

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
  const [pos] = await d.db.select().from(s.positions).where(and(eq(s.positions.paper, false), eq(s.positions.tokenId, t.tokenId), isNull(s.positions.closedAt))).limit(1);
  const fill = { side: t.side === "BUY" ? ("buy" as const) : ("sell" as const), shares: t.shares, price: t.price, fee: t.fee };
  if (!pos && fill.side === "sell") return;
  try {
    const next = applyFill(pos ? { shares: pos.size, avgCost: pos.avgCost, realizedPnl: pos.realizedPnl } : { shares: 0, avgCost: 0, realizedPnl: 0 }, fill);
    if (!pos) await d.db.insert(s.positions).values({ conditionId: o.conditionId, tokenId: t.tokenId, size: next.shares, avgCost: next.avgCost, realizedPnl: 0, openedAt: t.at, paper: false });
    else await d.db.update(s.positions).set({ size: next.shares, avgCost: next.avgCost, realizedPnl: next.realizedPnl, closedAt: next.shares <= EPS ? t.at : null }).where(eq(s.positions.id, pos.id));
  } catch {
    /* sell exceeds position */
  }
}

/** 3 newest live orders (since the last mode change) all rejected / unknown / failed => SPEC auto-downgrade. A mode change resets the streak, so re-raising to L2 is not instantly undone by old failures. */
async function orderErrors(d: Pick<Deps, "db">) {
  const [ev] = await d.db.select({ ts: s.autonomyEvents.ts }).from(s.autonomyEvents).where(eq(s.autonomyEvents.scope, "global")).orderBy(desc(s.autonomyEvents.id)).limit(1);
  const rows = await d.db.select({ st: s.orders.status }).from(s.orders)
    .where(and(eq(s.orders.paper, false), ev ? gt(s.orders.createdAt, ev.ts) : undefined)).orderBy(desc(s.orders.createdAt)).limit(3);
  return rows.length === 3 && rows.every((r) => FAILURES.includes(r.st)) ? 3 : 0;
}

/**
 * Pull trades + open orders; book new live fills (unique trade id => idempotent), move orders out of the open statuses, upsert live positions.
 * Order of writes (Neon HTTP has no tx): fill row first, then position. A crash between them loses a position update, which reconcile flags (fail-safe); the reverse would double-apply on retry.
 */
export async function syncFills(d: Deps) {
  const res = { fills: 0, updated: 0, failedUnknown: 0, error: undefined as string | undefined };
  const ex = d.exchange;
  if (!ex) return res;
  return withLock(d, "sync", 5 * MIN, async () => {
    const { db } = d, now = d.now();
    const last = ((await db.select({ ts: max(s.fills.ts) }).from(s.fills).where(eq(s.fills.paper, false))) as [{ ts: Date | null }])[0].ts;
    let trades: Trade[], open: Awaited<ReturnType<typeof ex.openOrders>>;
    try {
      [trades, open] = await Promise.all([ex.trades(new Date(last ? last.getTime() - MIN : now - DAY)), ex.openOrders()]); // 1 min overlap; unique trade id absorbs repeats
    } catch (e) {
      return { ...res, error: scrub(e instanceof Error ? e.message : "exchange error").slice(0, 300) };
    }
    const orders = await db.select().from(s.orders).where(eq(s.orders.paper, false));
    const filled = await liveFilled(db);
    const claimed = new Set(orders.flatMap((o) => (o.clobOrderId ? [o.clobOrderId] : [])));
    const openIds = new Set(open.map((x) => x.orderId));
    const touched = new Set<string>();
    const emit = (o: Order) => publish("order.updated", { id: o.id, orderId: o.clobOrderId ?? o.id, status: orderUi(o.status, filled.get(o.id) ?? 0), filledShares: filled.get(o.id) ?? 0 });
    const setStatus = async (o: Order, status: string, extra: Partial<Order> = {}) => {
      Object.assign(o, { status, ...extra });
      await db.update(s.orders).set({ status, ...extra }).where(eq(s.orders.id, o.id));
      if (status !== "failed_unknown") return;
      for (const p of await db.update(s.proposals).set({ status: "failed", error: "ORDER_FAILED_UNKNOWN" }).where(eq(s.proposals.orderId, o.id)).returning({ id: s.proposals.id }))
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
      const ins = await db.insert(s.fills).values({ orderId: o.id, ts: t.at, price: t.price, size: t.shares, fee: t.fee, paper: false, tradeId: t.tradeId }).onConflictDoNothing().returning({ id: s.fills.id });
      if (!ins.length) continue;
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
  await d.db.insert(s.reconciliations).values({ at, ok: true, baseline: true, usdcLedger: x.usdc, usdcExchange: x.usdc, positions: x.positions });
  publish("recon.done", { at: at.toISOString(), status: "ok", detail });
};

export async function reconcileJob(d: Deps) {
  const ex = d.exchange;
  if (!ex) return { status: null };
  return withLock(d, "reconcile", 5 * MIN, async () => {
    const { db } = d, at = new Date(d.now());
    const synced = async () => { const r = await syncFills(d); return !("skipped" in r) && !r.error; }; // book what the exchange already shows, or in-flight trades read as drift
    if (!(await synced())) return { status: null }; // stale ledger: judging it would be a false alarm
    const [base] = await db.select().from(s.reconciliations).where(eq(s.reconciliations.baseline, true)).orderBy(desc(s.reconciliations.id)).limit(1);
    let x = await snapshot(ex);
    if (!base) return (await insertBaseline(d, at, x, null), { status: "ok", mismatches: 0 });
    const check = async () => {
      const rows = await db.select({ f: s.fills, side: s.orders.side, tok: s.orders.tokenId }).from(s.fills).innerJoin(s.orders, eq(s.orders.id, s.fills.orderId)).where(and(eq(s.fills.paper, false), gt(s.fills.ts, base.at)));
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
    await db.insert(s.reconciliations).values({ at, ok: r.ok, usdcLedger: ledger, usdcExchange: x.usdc, mismatches: r.mismatches });
    const status = r.ok ? "ok" : "mismatch";
    publish("recon.done", { at: at.toISOString(), status, detail: reconDetail(r.mismatches) });
    if (!r.ok) await downgradeOn(d, { balanceMismatch: true });
    return { status, mismatches: r.mismatches.length };
  });
}

/** Accept the current exchange state as the new ledger base (deposit, withdrawal, payout, pre-existing holdings). Clears a recon halt; never changes mode. */
export async function rebaseline(d: Deps): Promise<{ ok: true; at: string } | { ok: false; error: string }> {
  const ex = d.exchange;
  if (!ex) return { ok: false, error: "exchange not configured" };
  const r = await withLock(d, "reconcile", 5 * MIN, async () => {
    const [busy] = await d.db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, ["sending", "unknown"]))).limit(1);
    if (busy) return { ok: false as const, error: "live orders are still sending or unknown" };
    const sy = await syncFills(d);
    if ("skipped" in sy || sy.error) return { ok: false as const, error: "fill sync unavailable, retry" };
    const [still] = await d.db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, ["sending", "unknown"]))).limit(1);
    if (still) return { ok: false as const, error: "live orders are still sending or unknown" };
    const at = new Date(d.now());
    await insertBaseline(d, at, await snapshot(ex), "rebaseline");
    return { ok: true as const, at: at.toISOString() };
  });
  return "skipped" in r ? { ok: false, error: "reconcile in progress, retry" } : r;
}

export const reconDetail = (mm: { key: string; ledger: number; exchange: number }[]) =>
  mm.length ? mm.map((m) => `${m.key.length > 12 ? `${m.key.slice(0, 8)}…` : m.key}: ledger ${+m.ledger.toFixed(4)} vs exchange ${+m.exchange.toFixed(4)}`).join("; ") : null;

/** Latest reconciliation for the UI: late = last run older than 10 min. */
export async function reconStatus(d: Pick<Deps, "db" | "now">) {
  const [r] = await d.db.select().from(s.reconciliations).orderBy(desc(s.reconciliations.id)).limit(1);
  if (!r) return { at: null, status: null, detail: null } as { at: string | null; status: "ok" | "mismatch" | "late" | null; detail: string | null };
  const late = d.now() - r.at.getTime() > 10 * MIN;
  return { at: r.at.toISOString(), status: (!r.ok ? "mismatch" : late ? "late" : "ok") as "ok" | "mismatch" | "late", detail: reconDetail(r.mismatches) };
}

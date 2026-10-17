import { checkSet, setLegPlan, unwindPlan, type Mode, type SetInputLeg } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub, type ImmediateResult } from "@pm/pm";
import { and, desc, eq, gt, gte, inArray, lt, or } from "drizzle-orm";
import { safeEqual } from "../auth";
import { currentMode } from "./autonomy";
import { feeOf, toMarket, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { BURNED, autoGate, halted, liveMode, newToken, ntfy, sha256, type Action, type Via } from "./live";
import { addExposure, eventOf, exposureOf } from "./paper";
import { latestSnaps, type StructDetail } from "./screen";
import { takeSnapshots } from "./sweep";
import { syncFills } from "./sync";

const MIN = 60_000;
const TTL = 15 * MIN; // same as single proposals
const FRESH = MIN; // leg books must be < 60 s old
const STUCK = 10 * MIN; // sending/unwinding this long => crashed mid-loop
const DRIFT = 0.02;
const LIVE: Mode[] = ["L2", "L3", "L4"];
const OPEN = ["pending", "sending", "unwinding", "flagged"]; // an event with one of these gets no new set
const EPS = 1e-6;

type SetRow = typeof s.proposalSets.$inferSelect;
type Row = typeof s.markets.$inferSelect;
type Snap = typeof s.snapshots.$inferSelect;
export type SetDecision =
  | { ok: true; state: string; reason?: string; error?: string }
  | { ok: false; error: "NOT_FOUND" | "INVALID_TOKEN" | "ALREADY_DECIDED" | "MODE" | "orders halted" | "busy" };

const casSet = async (d: Pick<Deps, "db">, id: string, from: string, set: Partial<SetRow>) =>
  (await d.db.update(s.proposalSets).set(set).where(and(eq(s.proposalSets.id, id), eq(s.proposalSets.status, from))).returning({ id: s.proposalSets.id })).length === 1;
const setEvent = (p: Pick<SetRow, "id" | "legs">, state: string, x: { legsFilled?: number; failedLeg?: number | null; error?: string | null } = {}) =>
  publish("set.updated", { id: p.id, state, legsFilled: x.legsFilled ?? 0, legsTotal: p.legs.length, failedLeg: x.failedLeg ?? null, error: x.error ?? null });
const propEvent = (p: Pick<SetRow, "id">, state: string, extra: Record<string, unknown> = {}) => publish("proposal.updated", { id: p.id, kind: "set", state, ...extra });

const markets = async (d: Pick<Deps, "db">, ids: string[]) => new Map((await d.db.select().from(s.markets).where(inArray(s.markets.conditionId, ids))).map((m) => [m.conditionId, m]));

/** Best ask/bid of the YES book in a snapshot row. */
function touch(sn: Snap | undefined) {
  const b = sn?.book;
  if (!b?.asks.length || !b.bids.length) return null;
  const ask = b.asks.reduce((x, l) => (l.price < x.price ? l : x)), bid = b.bids.reduce((x, l) => (l.price > x.price ? l : x));
  return { ask: { price: ask.price, size: ask.size }, bid: { price: bid.price, size: bid.size } };
}
/** setLegPlan input for these legs from fresh snapshots; null when any leg lacks tokens or a book younger than 60 s. */
function inputs(ids: string[], mk: Map<string, Row>, snaps: Map<string, Snap>, now: number): SetInputLeg[] | null {
  const out: SetInputLeg[] = [];
  for (const c of ids) {
    const m = mk.get(c), sn = snaps.get(c), t = touch(sn);
    if (!m?.yesTokenId || !m.noTokenId || !t || now - sn!.ts.getTime() > FRESH) return null;
    out.push({ conditionId: c, yesToken: m.yesTokenId, noToken: m.noTokenId, ...t });
  }
  return out;
}
/** Price a leg BUYs at: YES ask (buy-all) or NO = 1 - YES bid (sell-all). */
const legPrice = (kind: string, g: SetInputLeg) => (kind === "buy-all" ? g.ask.price : 1 - g.bid.price);
const fresh = async (d: Deps, ids: string[]) => {
  await takeSnapshots(d, ids);
  return latestSnaps(d.db, ids);
};
const feeRate = (rows: Row[]) => Math.max(0, ...rows.map((r) => feeOf(toMarket(r))));

// ---------------------------------------------------------------- housekeeping
/** Pending past expiry => expired; sending/unwinding older than 10 min (crash mid-loop) => flagged, leg orders left to fill sync. Runs at any mode. */
async function sweepSets(d: Deps) {
  const now = new Date(d.now());
  const exp = await d.db.update(s.proposalSets).set({ status: "expired", error: "TIMEOUT", decidedAt: now, ...BURNED })
    .where(and(eq(s.proposalSets.status, "pending"), lt(s.proposalSets.expiresAt, now))).returning();
  for (const p of exp) propEvent(p, "expired", { reason: "TIMEOUT" });
  const stuck = await d.db.update(s.proposalSets).set({ status: "flagged", error: "STUCK_SENDING" })
    .where(and(inArray(s.proposalSets.status, ["sending", "unwinding"]), lt(s.proposalSets.decidedAt, new Date(now.getTime() - STUCK)))).returning();
  for (const p of stuck) await flagged(d, p, "STUCK_SENDING");
  return { expired: exp.length, stuck: stuck.length };
}

// ---------------------------------------------------------------- propose
/**
 * L2+: latest neg-risk-sum detections (screens, last hour) become one pending set per event: fresh books on every leg, setLegPlan, one checkSet
 * (whole set = one order on the group's event). L2 approval; L3 auto inside limits.l3 (structuralAuto on, else fallback to approval); L4 auto. Below L2 only housekeeping runs.
 */
export async function proposeSets(d: Deps) {
  return withLock(d, "sets", 5 * MIN, async () => {
    const { db, settings: st } = d, now = d.now();
    const mode = await currentMode(db);
    const res = { mode, ...(await sweepSets(d)), detected: 0, proposed: 0, skipped: {} as Record<string, number> };
    const skip = (r: string) => void (res.skipped[r] = (res.skipped[r] ?? 0) + 1);
    if (!LIVE.includes(mode) || !d.exchange) return res;
    if (await halted(d)) return (skip("HALTED"), res);

    const scr = await db.selectDistinctOn([s.screens.conditionId]).from(s.screens).where(and(eq(s.screens.structuralFlag, true), gte(s.screens.ts, new Date(now - 60 * MIN))))
      .orderBy(s.screens.conditionId, desc(s.screens.ts));
    const det = new Map<string, { kind: "buy-all" | "sell-all"; legs: string[] }>();
    for (const r of scr) {
      const x = r.structuralDetail as StructDetail | null;
      if (x?.type === "neg-risk-sum" && x.kind && x.legs.length >= 2) det.set([...x.legs].sort().join(), { kind: x.kind, legs: x.legs });
    }
    res.detected = det.size;
    if (!det.size) return res;
    const mk = await markets(d, [...det.values()].flatMap((x) => x.legs));
    const busy = new Set((await db.select({ e: s.proposalSets.eventId }).from(s.proposalSets)
      .where(or(inArray(s.proposalSets.status, OPEN), and(eq(s.proposalSets.status, "rejected"), gt(s.proposalSets.createdAt, new Date(now - 60 * MIN)))))).map((x) => x.e));
    const cands = [...det.values()].flatMap((x) => {
      const g = mk.get(x.legs[0]!)?.negRiskGroup;
      if (!g || x.legs.some((c) => mk.get(c)?.negRiskGroup !== g)) return (skip("NOT_ONE_GROUP"), []);
      if (busy.has(g)) return (skip("EVENT_BUSY"), []);
      return [{ ...x, event: g }];
    });
    if (!cands.length) return res;
    const snaps = await fresh(d, cands.flatMap((x) => x.legs));
    const xp = await exposureOf(db, st.bankroll, now, false);

    for (const c of cands) {
      const rows = c.legs.map((id) => mk.get(id)!);
      const inp = inputs(c.legs, mk, snaps, d.now());
      if (!inp) { skip("STALE_BOOK"); continue; }
      // shares: thinnest touch, capped so the set costs <= capFrac x bankroll at the caps (slack 0.01)
      const depth = Math.min(...inp.map((g) => (c.kind === "buy-all" ? g.ask.size : g.bid.size)));
      const perShare = inp.reduce((t, g) => t + Math.min(0.99, legPrice(c.kind, g) + 0.01), 0);
      const shares = Math.floor(Math.min(depth, (st.capFrac * st.bankroll) / perShare) * 100) / 100;
      if (!(shares > 0)) { skip("TOO_THIN"); continue; }
      const plan = setLegPlan(c.kind, inp, shares, feeRate(rows));
      if (!plan.ok) { skip(plan.reason); continue; }
      const row0 = rows[0]!, category = row0.category ?? "other";
      const chk = checkSet(plan.legs.map((l) => ({ sizeUsd: l.shares * l.limit, marketId: l.conditionId })), { eventId: c.event, category }, xp, st.limits);
      if (!chk.ok) { chk.violations.forEach((v) => skip(`RISK_${v.rule}`)); continue; }
      const tmode = await liveMode(d, row0);
      if (!LIVE.includes(tmode)) { skip("MODE"); continue; }
      const fallbackReason = tmode === "L3" ? await autoGate(d, tmode, { sizeUsd: plan.totalCost, category, isSet: true }) : null;

      const by = new Map(inp.map((g) => [g.conditionId, g]));
      const approve = newToken(), reject = newToken();
      let p: SetRow | undefined;
      try {
        [p] = await db.insert(s.proposalSets).values({
          eventId: c.event, kind: c.kind, shares, totalCost: plan.totalCost, edge: plan.edge,
          legs: plan.legs.map((l) => ({ ...l, price: legPrice(c.kind, by.get(l.conditionId)!) })),
          fallbackReason, createdAt: new Date(now), expiresAt: new Date(now + TTL), approveTokenHash: sha256(approve), rejectTokenHash: sha256(reject),
        }).returning();
      } catch {
        skip("DUPLICATE_PENDING"); // partial unique index: one pending set per event
        continue;
      }
      for (const l of plan.legs) addExposure(xp, mk.get(l.conditionId)!, l.shares * l.limit);
      res.proposed++;
      publish("proposal.created", { id: p!.id, kind: "set", eventId: c.event });
      if (tmode !== "L2" && !fallbackReason) {
        const r = await decideSet(d, p!.id, "approve", "auto");
        if (r.ok && r.state !== "pending") continue;
        if (!r.ok && r.error !== "busy") continue;
      }
      await notifySet(p!, row0.question, { approve, reject });
    }
    return res;
  });
}

/** ntfy push with approve/reject for the whole set; token in the POST body (same pattern as live.notify). */
export function notifySet(p: SetRow, question: string, tokens: Record<Action, string>, env = process.env, f: typeof fetch = fetch) {
  const url = `${(env.APP_URL ?? "").replace(/\/$/, "")}/api/sets/${p.id}/push`;
  const action = (a: Action) => ({ action: "http", label: a === "approve" ? "Approve" : "Reject", url, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a, token: tokens[a] }), clear: true });
  return ntfy({
    title: "Live set needs approval", priority: 4,
    message: `${question.slice(0, 100)}\n${p.kind.toUpperCase()} ${p.legs.length} legs x ${p.shares} = $${p.totalCost.toFixed(2)}\nlocked $${p.edge.toFixed(2)} · expires ${p.expiresAt.toISOString().slice(11, 16)}Z`,
    actions: env.APP_URL ? [action("approve"), action("reject")] : [],
  }, env, f);
}

// ---------------------------------------------------------------- decide
/** Approve/reject one pending set. Same guards as live.decide: push token, mode, halt, expiry (15 min, or > 2c leg move that no longer re-plans), risk, CAS under live-send. */
export async function decideSet(d: Deps, id: string, action: Action, via: Via, token?: string): Promise<SetDecision> {
  const p = (await d.db.select().from(s.proposalSets).where(eq(s.proposalSets.id, id)).limit(1))[0];
  if (via === "push") {
    const want = p ? (action === "approve" ? p.approveTokenHash : p.rejectTokenHash) : "";
    if (!token || !safeEqual(sha256(token), want || "0".repeat(64)) || !p || want.length !== 64) return { ok: false, error: "INVALID_TOKEN" };
  }
  if (!p) return { ok: false, error: "NOT_FOUND" };
  if (p.status !== "pending") return { ok: false, error: "ALREADY_DECIDED" };
  const decided = { decidedAt: new Date(d.now()), decidedVia: via, ...BURNED };

  if (action === "reject") {
    if (!(await casSet(d, p.id, "pending", { status: "rejected", ...decided }))) return { ok: false, error: "ALREADY_DECIDED" };
    propEvent(p, "rejected");
    return { ok: true, state: "rejected" };
  }

  const ids = p.legs.map((l) => l.conditionId), mk = await markets(d, ids), row0 = mk.get(ids[0]!)!;
  const mode = await liveMode(d, row0);
  if (!d.exchange || !LIVE.includes(mode) || (via === "auto" && mode === "L2")) return { ok: false, error: "MODE" };
  if (await halted(d)) return { ok: false, error: "orders halted" };
  if (d.now() >= p.expiresAt.getTime()) return expireSet(d, p, "TIMEOUT");

  const inp = inputs(ids, mk, await fresh(d, ids), d.now());
  if (!inp) return expireSet(d, p, "PRICE_MOVED"); // no fresh book on a leg: cannot prove the prices held
  const by = new Map(inp.map((g) => [g.conditionId, g]));
  const px = p.legs.map((l) => legPrice(p.kind, by.get(l.conditionId)!));
  if (p.legs.some((l, i) => px[i]! > l.limit + EPS)) return expireSet(d, p, "PRICE_MOVED"); // touch above the approved cap: the FOK would die
  if (p.legs.some((l, i) => Math.abs(px[i]! - l.price) > DRIFT + EPS) && !setLegPlan(p.kind as "buy-all" | "sell-all", inp, p.shares, feeRate([...mk.values()])).ok) return expireSet(d, p, "PRICE_MOVED");

  const r = await withLock(d, "live-send", 2 * MIN, async (): Promise<SetDecision> => {
    const chk = checkSet(p.legs.map((l) => ({ sizeUsd: l.shares * l.limit, marketId: l.conditionId })), { eventId: eventOf(row0), category: row0.category ?? "other" },
      await exposureOf(d.db, d.settings.bankroll, d.now(), false), d.settings.limits);
    if (!chk.ok) {
      const error = `risk: ${chk.violations.map((v) => v.rule).join(",")}`;
      if (!(await casSet(d, p.id, "pending", { status: "failed", error, ...decided }))) return { ok: false, error: "ALREADY_DECIDED" };
      propEvent(p, "failed", { error });
      return { ok: true, state: "failed", error };
    }
    if (via === "auto" && mode === "L3" && (await autoGate(d, mode, { sizeUsd: p.totalCost, category: row0.category ?? "other", isSet: true }))) return { ok: true, state: "pending" }; // daily cap re-checked under the lock
    if (!(await casSet(d, p.id, "pending", { status: "sending", ...decided }))) return { ok: false, error: "ALREADY_DECIDED" };
    propEvent(p, "sending");
    return sendSet(d, p, mode, row0, via);
  });
  return "skipped" in r ? { ok: false, error: "busy" } : r;
}

async function expireSet(d: Deps, p: SetRow, reason: "TIMEOUT" | "PRICE_MOVED"): Promise<SetDecision> {
  if (!(await casSet(d, p.id, "pending", { status: "expired", error: reason, decidedAt: new Date(d.now()), ...BURNED }))) return { ok: false, error: "ALREADY_DECIDED" };
  propEvent(p, "expired", { reason });
  return { ok: true, state: "expired", reason };
}

// ---------------------------------------------------------------- send
const ordStatus = (r: ImmediateResult) => (r.status === "filled" ? "filled" : r.status === "rejected" ? "rejected" : "cancelled"); // partial/killed remainder is dead (FOK/FAK)
const errOf = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Legs in plan order, each a capped FOK BUY; order row 'sending' (key set:<id>:<leg>) is written BEFORE placeImmediate. Mode/halt checked before every leg.
 * Leg killed/rejected (or kill/halt) => unwind filled legs with capped FAK SELLs. A throw is an unknown leg: order 'unknown', set flagged, no resend, no unwind.
 * Fills/positions are NOT written here: fill sync books the venue trades by clob id (unique trade id), exactly like single live orders, so the recon ledger
 * sees one cash flow per trade. A BUY can overfill (USD-sized): the extra shares are kept and recorded by sync; unwind sells what actually filled.
 */
async function sendSet(d: Deps, p: SetRow, mode: Mode, row0: Row, via: Via): Promise<SetDecision> {
  const ex = d.exchange!;
  const filled: { conditionId: string; token: string; shares: number; fillPrice: number; leg: number }[] = [];
  const order = async (leg: number, key: string, o: { conditionId: string; token: string; side: "BUY" | "SELL"; price: number; shares: number }) => {
    const id = `ord_${crypto.randomUUID().slice(0, 12)}`;
    await d.db.insert(s.orders).values({
      id, thesisId: `set:${p.id}`, idempotencyKey: key, attempt: leg, paper: false, conditionId: o.conditionId, tokenId: o.token, side: o.side,
      limitPrice: o.price, size: o.shares, modeAtSend: mode, approval: via === "auto" ? "auto" : "user", status: "sending", createdAt: new Date(d.now()), setId: p.id,
    });
    return id;
  };
  const record = async (id: string, r: ImmediateResult) => {
    await d.db.update(s.orders).set({ status: ordStatus(r), clobOrderId: r.clobOrderId ?? null }).where(eq(s.orders.id, id));
    publish("order.updated", { id, orderId: r.clobOrderId ?? id, status: ordStatus(r), filledShares: r.filledShares, setId: p.id });
  };
  const done = async (from: string, state: string, extra: Partial<SetRow> = {}) => {
    await casSet(d, p.id, from, { status: state, ...extra });
    setEvent(p, state, { legsFilled: filled.length, failedLeg: extra.failedLeg, error: extra.error });
    propEvent(p, state, extra.error ? { error: extra.error } : {});
    await syncFills(d).catch(() => undefined); // book the trades now so exposure/positions see them; the cron retries otherwise
    return { ok: true as const, state, ...(extra.error ? { error: extra.error } : {}) };
  };

  let stop: { leg: number; error: string } | undefined;
  for (const [i, l] of p.legs.entries()) {
    const blocked = !LIVE.includes(await liveMode(d, row0)) ? "KILLED" : (await halted(d)) ? "orders halted" : null;
    if (blocked) { stop = { leg: i, error: blocked }; break; }
    const oid = await order(i, `set:${p.id}:${i}`, { conditionId: l.conditionId, token: l.token, side: "BUY", price: l.limit, shares: l.shares });
    setEvent(p, "sending", { legsFilled: filled.length });
    let r: ImmediateResult;
    try {
      r = await ex.placeImmediate({ tokenId: l.token, side: "BUY", shares: l.shares, capPrice: l.limit, type: "FOK" });
    } catch (e) {
      await d.db.update(s.orders).set({ status: "unknown" }).where(eq(s.orders.id, oid));
      const error = `leg ${i + 1} unknown: ${errOf(e)}`.slice(0, 300);
      const res = await done("sending", "flagged", { failedLeg: i, error });
      await alert(d, p, error);
      return res;
    }
    await record(oid, r);
    if (r.filledShares > EPS) filled.push({ conditionId: l.conditionId, token: l.token, shares: r.filledShares, fillPrice: r.avgPrice, leg: i });
    if (r.status !== "filled") { stop = { leg: i, error: scrub(r.error ?? r.status).slice(0, 300) }; break; }
  }
  if (!stop) return done("sending", "filled");
  const error = `leg ${stop.leg + 1}: ${stop.error}`.slice(0, 300);
  if (!filled.length) return done("sending", "failed", { failedLeg: stop.leg, error });

  // unwind: capped FAK SELL per filled leg (floor = fill - 0.02). Not gated on mode/halt: it only reduces exposure.
  await casSet(d, p.id, "sending", { status: "unwinding", failedLeg: stop.leg, error });
  setEvent(p, "unwinding", { legsFilled: filled.length, failedLeg: stop.leg, error });
  const left: string[] = [];
  for (const [j, u] of unwindPlan(filled).entries()) {
    const leg = filled[j]!.leg;
    const oid = await order(leg, `set:${p.id}:u${leg}`, { conditionId: u.conditionId, token: u.token, side: "SELL", price: u.floor, shares: u.shares });
    try {
      const r = await ex.placeImmediate({ tokenId: u.token, side: "SELL", shares: u.shares, capPrice: u.floor, type: "FAK" });
      await record(oid, r);
      if (u.shares - r.filledShares > EPS) left.push(`leg ${leg + 1}: ${+(u.shares - r.filledShares).toFixed(4)} held`);
    } catch (e) {
      await d.db.update(s.orders).set({ status: "unknown" }).where(eq(s.orders.id, oid));
      left.push(`leg ${leg + 1}: unwind unknown (${errOf(e)})`);
    }
  }
  if (!left.length) return done("unwinding", "unwound", { failedLeg: stop.leg, error });
  const ferr = `${error}; ${left.join("; ")}`.slice(0, 300);
  const res = await done("unwinding", "flagged", { failedLeg: stop.leg, error: ferr });
  await alert(d, p, ferr);
  return res;
}

/** Set flagged => loud push (no actions: manual work on the venue). */
const alert = (_d: Deps, p: SetRow, error: string) =>
  ntfy({ title: "Set flagged: manual action", priority: 5, message: `${p.kind} ${p.legs.length} legs x ${p.shares} (set ${p.id.slice(0, 8)})\n${error}\nThe engine will not retry. New live orders are halted until acknowledged.` });

async function flagged(d: Deps, p: SetRow, error: string) {
  await d.db.update(s.proposalSets).set({ error }).where(eq(s.proposalSets.id, p.id));
  setEvent(p, "flagged", { error });
  propEvent(p, "flagged", { error });
  await alert(d, p, error);
}

// ---------------------------------------------------------------- ack
/** flagged -> acknowledged. Closes nothing; logs an autonomy_events row (scope set:<id>, never read as the global mode). */
export async function ackSet(d: Pick<Deps, "db" | "now">, id: string): Promise<{ ok: true; state: "acknowledged" } | { ok: false; error: "NOT_FOUND" | "NOT_FLAGGED" }> {
  const p = (await d.db.select().from(s.proposalSets).where(eq(s.proposalSets.id, id)).limit(1))[0];
  if (!p) return { ok: false, error: "NOT_FOUND" };
  if (!(await casSet(d, id, "flagged", { status: "acknowledged" }))) return { ok: false, error: "NOT_FLAGGED" };
  const mode = await currentMode(d.db);
  await d.db.insert(s.autonomyEvents).values({ ts: new Date(d.now()), fromMode: mode, toMode: mode, scope: `set:${id}`, reason: `flagged set acknowledged: ${p.error ?? ""}`.slice(0, 300), actor: "user" });
  setEvent(p, "acknowledged", { failedLeg: p.failedLeg, error: p.error });
  return { ok: true, state: "acknowledged" };
}

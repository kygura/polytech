import { checkOrder, effectiveMode, gtdExpiry, livelimitPrice, proposalExpiry, type Mode } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { safeEqual } from "../auth";
import { currentMode, downgradeOn } from "./autonomy";
import { withLock, type Deps } from "./deps";
import { publish } from "./events";
import { LIVE_OPEN, addExposure, assess, candidates, downgradeSignals, eventOf, exposureOf, openBook } from "./paper";
import { latestSnaps } from "./screen";
import { takeSnapshots } from "./sweep";

const MIN = 60_000;
const TTL = 15 * MIN; // SPEC: proposals expire after 15 min (core proposalExpiry)
const TICK = 0.01; // ponytail: per-market tick not stored (snapshots drop tick_size); 0.01 is the common tick, store it if 0.001 markets matter
const SHARE_STEP = 100; // shares rounded down to 0.01 so cost never exceeds the risk-checked sizeUsd

type Proposal = typeof s.proposals.$inferSelect;
type Row = typeof s.markets.$inferSelect;
export type Action = "approve" | "reject";
export type Via = "web" | "tui" | "push";
/** UI state: db 'approved' is shown as 'sending' (DESIGN 8.7). */
export const uiState = (st: string) => (st === "approved" ? "sending" : st);

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const sideMid = (yesMid: number, tokenId: string, m: Row) => (tokenId === m.yesTokenId ? yesMid : 1 - yesMid);

function updated(p: Pick<Proposal, "id">, state: string, extra: { reason?: string; error?: string; orderId?: string } = {}) {
  publish("proposal.updated", { id: p.id, state: uiState(state), ...extra });
}

/** CAS on status: only a row still in `from` changes. Returns false when someone else got there first. Neon HTTP has no transactions. */
async function cas(d: Pick<Deps, "db">, id: string, from: string, set: Partial<Proposal>) {
  return (await d.db.update(s.proposals).set(set).where(and(eq(s.proposals.id, id), eq(s.proposals.status, from))).returning({ id: s.proposals.id })).length === 1;
}
// Hashes are NOT NULL in the schema: "" never equals a sha256 hex, so a cleared hash is a burned token.
export const BURNED = { approveTokenHash: "", rejectTokenHash: "" };
const decided = (d: Pick<Deps, "now">, via: Via) => ({ decidedAt: new Date(d.now()), decidedVia: via, ...BURNED });

/** Latest reconciliation says mismatch => no new live orders. No row yet => not halted. */
async function halted(d: Pick<Deps, "db">) {
  const r = (await d.db.select().from(s.reconciliations).orderBy(desc(s.reconciliations.id)).limit(1))[0];
  return r ? !r.ok : false;
}

/** orderId -> shares filled so far (live book). */
export async function liveFilled(db: Deps["db"]) {
  const rows = await db.select({ o: s.fills.orderId, n: sql<number>`sum(${s.fills.size})::float8` }).from(s.fills).where(eq(s.fills.paper, false)).groupBy(s.fills.orderId);
  return new Map(rows.map((r) => [r.o, r.n]));
}
/**
 * DESIGN 8.7 order state: live -> open|partial; matched (matched, not yet settled) -> partial until all `shares` are filled, then filled;
 * rejected|failed_unknown -> failed (NOT in 8.7: UI must add it); sending|unknown|filled|cancelled|expired pass through.
 * `shares` omitted => matched reads as partial (never claims filled without proof).
 */
export const orderUi = (status: string, filled: number, shares = Infinity) =>
  status === "live" ? (filled > 0 ? "partial" : "open")
  : status === "matched" ? (filled >= shares - 1e-9 ? "filled" : "partial")
  : status === "rejected" || status === "failed_unknown" ? "failed"
  : status;

async function liveMode(d: Deps, m: Row): Promise<Mode> {
  return effectiveMode(await currentMode(d.db), d.settings.overrides[m.category ?? ""]);
}

// ---------------------------------------------------------------- propose
/** L2: every qualifying thesis becomes one pending proposal (no order yet). Same selection + checks as paper, risk against the live book only. */
export async function propose(d: Deps) {
  return withLock(d, "propose", 5 * MIN, async () => {
    const { db, settings: st } = d, now = d.now();
    const mode = await currentMode(db);
    const res = { mode, candidates: 0, proposed: 0, skipped: {} as Record<string, number> };
    if (mode !== "L2" || !d.exchange) return res;
    const skip = (r: string) => void (res.skipped[r] = (res.skipped[r] ?? 0) + 1);
    if (await halted(d)) return (skip("RECON_HALTED"), res);

    // held: open live position or live order on the market; theses with any non-expired proposal are done (rejected/failed are not re-proposed)
    const held = new Set((await openBook(db, false)).map((x) => x.p.conditionId));
    for (const o of await db.select({ c: s.orders.conditionId }).from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN)))) held.add(o.c);
    const done = new Set((await db.select({ t: s.proposals.thesisId }).from(s.proposals).where(ne(s.proposals.status, "expired"))).map((x) => x.t));
    const { cands: all, mk } = await candidates(d, "L2", held);
    const cands = all.filter((t) => !done.has(t.id));
    res.candidates = cands.length;
    if (cands.length) await takeSnapshots(d, cands.map((t) => t.conditionId)); // fresh book (< 60 s)
    const x = await exposureOf(db, st.bankroll, now, false);
    const dg = await downgradeOn(d, await downgradeSignals(d, x, cands.length)); // L2 auto-downgrades: daily loss (live realized), stale feed
    if (dg) return { ...res, mode: dg };
    if (!cands.length) return res;
    const snaps = await latestSnaps(db, cands.map((t) => t.conditionId));

    for (const t of cands) {
      const row = mk.get(t.conditionId)!;
      if (row.negRiskGroup) { skip("STRUCTURAL_PHASE7"); continue; } // neg-risk set legs are structural: auto/arb execution is phase 7
      const a = assess(d, t, row, snaps.get(t.conditionId), now);
      if (!a.ok) { a.failed.forEach(skip); continue; }
      const { sz } = a;
      const tokenId = t.side === "YES" ? row.yesTokenId : row.noTokenId;
      const limit = livelimitPrice({ vwap: sz.sizeUsd / sz.shares, pPost: sz.pPost, tick: TICK });
      if (!tokenId || limit == null) { skip("NO_LIMIT"); continue; }
      if (!gtdExpiry(t.expiresAt, new Date(now))) { skip("THESIS_EXPIRING"); continue; }
      const shares = Math.floor((sz.sizeUsd / limit) * SHARE_STEP) / SHARE_STEP;
      if (!(shares > 0)) { skip("NO_LIMIT"); continue; }
      const sizeUsd = shares * limit;
      const chk = checkOrder({ sizeUsd, marketId: t.conditionId, eventId: eventOf(row), category: row.category ?? "other" }, x, st.limits);
      if (!chk.ok) { chk.violations.forEach((v) => skip(`RISK_${v.rule}`)); continue; }

      if ((await currentMode(db)) !== "L2") { skip("MODE_CHANGED"); break; } // killed mid-run
      const approve = newToken(), reject = newToken();
      let p: Proposal | undefined;
      try {
        [p] = await db.insert(s.proposals).values({
          thesisId: t.id, conditionId: t.conditionId, tokenId, side: "BUY", kind: "entry", sizeUsd, shares, limitPrice: limit,
          expectedProfit: shares * sz.e, priceAtProposal: sz.pMid, createdAt: new Date(now), expiresAt: new Date(now + TTL),
          approveTokenHash: sha256(approve), rejectTokenHash: sha256(reject),
        }).returning();
      } catch {
        skip("DUPLICATE_PENDING"); // partial unique index: one pending per thesis
        continue;
      }
      addExposure(x, row, sizeUsd); // later candidates in this run see this one
      res.proposed++;
      publish("proposal.created", { id: p!.id, conditionId: t.conditionId });
      await notify(p!, row.question, t.side, { approve, reject });
    }
    return res;
  });
}

/** POST one ntfy message. NTFY_TOPIC unset => skipped. Never throws (5 s timeout), so it never blocks the caller's real work. */
async function ntfy(msg: { title: string; message: string; priority: number; actions?: unknown[] }, env = process.env, f: typeof fetch = fetch) {
  const topic = env.NTFY_TOPIC;
  if (!topic) return false;
  try {
    const r = await f((env.NTFY_URL || "https://ntfy.sh").replace(/\/$/, ""), {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) },
      body: JSON.stringify({ topic, ...msg }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Mode change alert (incl. kill and auto-downgrade). Informational: no action buttons. */
export const notifyMode = (text: string, env = process.env, f: typeof fetch = fetch) => ntfy({ title: "Mode changed", message: text, priority: 4 }, env, f);

/** ntfy push with approve/reject http actions. The single-use token travels in the POST body (not the URL, so it stays out of access logs). */
export function notify(p: Proposal, question: string, side: string, tokens: Record<Action, string>, env = process.env, f: typeof fetch = fetch) {
  const url = `${(env.APP_URL ?? "").replace(/\/$/, "")}/api/proposals/${p.id}/push`;
  const action = (a: Action) => ({ action: "http", label: a === "approve" ? "Approve" : "Reject", url, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a, token: tokens[a] }), clear: true });
  return ntfy({
    title: "Live order needs approval", priority: 4,
    message: `${question.slice(0, 120)}\nBUY ${side} ${p.shares} @ ${p.limitPrice.toFixed(3)} = $${(p.shares * p.limitPrice).toFixed(2)}\nE[profit] $${p.expectedProfit.toFixed(2)} · expires ${p.expiresAt.toISOString().slice(11, 16)}Z`,
    actions: env.APP_URL ? [action("approve"), action("reject")] : [],
  }, env, f);
}

// ---------------------------------------------------------------- decide + send
export type Decision =
  | { ok: true; state: string; reason?: string; error?: string; orderId?: string }
  | { ok: false; error: "NOT_FOUND" | "INVALID_TOKEN" | "ALREADY_DECIDED" | "MODE" | "orders halted" | "busy" };

/**
 * Approve or reject one pending proposal. web/tui callers are already authenticated (no token);
 * via 'push' needs the action's single-use token (both hashes are burned on any decision).
 */
export async function decide(d: Deps, id: string, action: Action, via: Via, token?: string): Promise<Decision> {
  const p = (await d.db.select().from(s.proposals).where(eq(s.proposals.id, id)).limit(1))[0];
  if (via === "push") {
    const want = p ? (action === "approve" ? p.approveTokenHash : p.rejectTokenHash) : "";
    // compare against a dummy when the row is missing so timing does not reveal ids
    if (!token || !safeEqual(sha256(token), want || "0".repeat(64)) || !p || want.length !== 64) return { ok: false, error: "INVALID_TOKEN" };
  }
  if (!p) return { ok: false, error: "NOT_FOUND" };
  if (p.status !== "pending") return { ok: false, error: "ALREADY_DECIDED" };

  if (action === "reject") {
    if (!(await cas(d, p.id, "pending", { status: "rejected", ...decided(d, via) }))) return { ok: false, error: "ALREADY_DECIDED" };
    updated(p, "rejected");
    return { ok: true, state: "rejected" };
  }

  const row = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, p.conditionId)))[0]!;
  if (!d.exchange || (await liveMode(d, row)) !== "L2") return { ok: false, error: "MODE" };
  if (await halted(d)) return { ok: false, error: "orders halted" };

  await takeSnapshots(d, [p.conditionId]); // fresh mid for the drift check
  const snap = (await latestSnaps(d.db, [p.conditionId])).get(p.conditionId);
  const now = d.now();
  const reason = proposalExpiry(p, new Date(now), snap?.mid == null ? NaN : sideMid(snap.mid, p.tokenId, row)) ?? (snap?.mid == null ? "PRICE_MOVED" : null); // no book = cannot prove the price held
  if (reason) return expire(d, p, reason);

  // approve-time price policy: recompute pPost on the fresh mid exactly as propose does; fail closed if it cannot be recomputed
  const th = (await d.db.select().from(s.theses).where(eq(s.theses.id, p.thesisId)))[0];
  const a = th ? assess(d, th, row, snap, now) : undefined;
  if (!a?.ok || livelimitPrice({ vwap: p.limitPrice, pPost: a.sz.pPost, tick: TICK }) == null) return expire(d, p, "PRICE_MOVED");

  // Risk re-check -> CAS -> order insert -> place under one lock: two approvals cannot both pass the same caps. Held => busy, proposal stays pending.
  const r = await withLock(d, "live-send", 60_000, async (): Promise<Decision> => {
    const chk = checkOrder({ sizeUsd: p.shares * p.limitPrice, marketId: p.conditionId, eventId: eventOf(row), category: row.category ?? "other" }, await exposureOf(d.db, d.settings.bankroll, now, false), d.settings.limits);
    if (!chk.ok) {
      const error = `risk: ${chk.violations.map((v) => v.rule).join(",")}`;
      if (!(await cas(d, p.id, "pending", { status: "failed", error, ...decided(d, via) }))) return { ok: false, error: "ALREADY_DECIDED" };
      updated(p, "failed", { error });
      return { ok: true, state: "failed", error };
    }
    if (!(await cas(d, p.id, "pending", { status: "approved", ...decided(d, via) }))) return { ok: false, error: "ALREADY_DECIDED" };
    updated(p, "approved");
    return send(d, p);
  });
  return "skipped" in r ? { ok: false, error: "busy" } : r;
}

async function expire(d: Deps, p: Proposal, reason: "TIMEOUT" | "PRICE_MOVED"): Promise<Decision> {
  // reason lives in `error` (no reason column); read model splits it back out for expired rows
  if (!(await cas(d, p.id, "pending", { status: "expired", error: reason, decidedAt: new Date(d.now()), ...BURNED }))) return { ok: false, error: "ALREADY_DECIDED" };
  updated(p, "expired", { reason });
  return { ok: true, state: "expired", reason };
}

/**
 * Exactly one exchange.place per approved proposal. Caller won the pending->approved CAS, so this runs once per proposal.
 * The order row (unique idempotency key) is written BEFORE place: a crash after it leaves 'sending', never a resend.
 * A throw from place is ambiguous (may have reached the venue) => order 'unknown', no retry; fill sync (P4) resolves it.
 */
async function send(d: Deps, p: Proposal): Promise<Decision> {
  const fail = async (error: string, orderId?: string) => {
    await cas(d, p.id, "approved", { status: "failed", error, ...(orderId ? { orderId } : {}) });
    updated(p, "failed", { error, ...(orderId ? { orderId } : {}) });
    return { ok: true as const, state: "failed", error };
  };
  const now = d.now();
  const th = (await d.db.select().from(s.theses).where(eq(s.theses.id, p.thesisId)))[0];
  const expiresAt = gtdExpiry(th?.expiresAt ?? null, new Date(now));
  if (!th || !expiresAt) return fail("thesis expiring");

  // Double-send guard = the pending->approved CAS (one winner) + an order row written before place that is never re-sent while sending/unknown.
  // The (thesis, attempt) idempotency key below is an audit trail only, not the guard.
  const attempt = (await d.db.select({ n: sql<number>`count(*)::int` }).from(s.orders).where(and(eq(s.orders.thesisId, p.thesisId), eq(s.orders.paper, false))))[0]!.n;
  const orderId = `ord_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await d.db.insert(s.orders).values({
      id: orderId, thesisId: p.thesisId, idempotencyKey: `${p.thesisId}:${attempt}`, attempt, paper: false, conditionId: p.conditionId, tokenId: p.tokenId,
      side: p.side, limitPrice: p.limitPrice, size: p.shares, modeAtSend: "L2", approval: "user", status: "sending", expiresAt, createdAt: new Date(now),
    });
  } catch {
    return fail("duplicate order key: not sent"); // another send owns (thesis, attempt)
  }
  await d.db.update(s.proposals).set({ orderId }).where(eq(s.proposals.id, p.id));

  // kill/halt can land between the CAS and here: re-check right before the only exchange call
  const blocked = (await currentMode(d.db)) !== "L2" ? "KILLED" : (await halted(d)) ? "orders halted" : null;
  if (blocked) {
    await d.db.update(s.orders).set({ status: "cancelled" }).where(eq(s.orders.id, orderId)); // never sent
    return fail(blocked, orderId);
  }
  let placed;
  try {
    placed = await d.exchange!.place({ tokenId: p.tokenId, side: p.side as "BUY" | "SELL", price: p.limitPrice, shares: p.shares, expiresAt });
  } catch (e) {
    await d.db.update(s.orders).set({ status: "unknown" }).where(eq(s.orders.id, orderId));
    return fail(scrub(e instanceof Error ? e.message : "place failed").slice(0, 300), orderId);
  }
  await d.db.update(s.orders).set({ status: placed.status, clobOrderId: placed.orderId || null }).where(eq(s.orders.id, orderId));
  if (placed.status === "rejected") return fail(scrub(placed.error ?? "rejected").slice(0, 300), orderId);
  if ((await currentMode(d.db)) !== "L2") { // killed while place was in flight: pull the order back
    try {
      await d.exchange!.cancel([placed.orderId]);
      if (placed.status === "live") await d.db.update(s.orders).set({ status: "cancelled" }).where(eq(s.orders.id, orderId)); // matched stays for fill sync (may already be filled)
      return fail("KILLED", orderId);
    } catch (e) {
      return fail(`KILLED: cancel failed, order left for sync: ${scrub(e instanceof Error ? e.message : "cancel failed")}`.slice(0, 300), orderId);
    }
  }
  await cas(d, p.id, "approved", { status: "sent" });
  updated(p, "sent", { orderId: placed.orderId });
  return { ok: true, state: "sent", orderId: placed.orderId };
}

// ---------------------------------------------------------------- expire
/** Pending proposals past 15 min, or whose side mid (latest snapshot) moved > 2c, become expired. 'approved' with no order for > 2 min (crash before the order row) fails as STUCK_APPROVED. */
export async function expireProposals(d: Deps) {
  const stuck = await d.db.update(s.proposals).set({ status: "failed", error: "STUCK_APPROVED" })
    .where(and(eq(s.proposals.status, "approved"), isNull(s.proposals.orderId), lt(s.proposals.decidedAt, new Date(d.now() - 2 * MIN)))).returning({ id: s.proposals.id });
  for (const p of stuck) updated(p, "failed", { error: "STUCK_APPROVED" });
  const pend = await d.db.select().from(s.proposals).where(eq(s.proposals.status, "pending"));
  const out = { checked: pend.length, expired: 0, stuck: stuck.length };
  if (!pend.length) return out;
  const ids = [...new Set(pend.map((p) => p.conditionId))];
  const [snaps, mk] = await Promise.all([latestSnaps(d.db, ids), d.db.select().from(s.markets).where(inArray(s.markets.conditionId, ids))]);
  const M = new Map(mk.map((m) => [m.conditionId, m]));
  const now = new Date(d.now());
  for (const p of pend) {
    const mid = snaps.get(p.conditionId)?.mid, m = M.get(p.conditionId);
    // no snapshot: only TIMEOUT can fire (NaN never reads as a move here; approve re-checks on a fresh book)
    const reason = proposalExpiry(p, now, mid == null || !m ? p.priceAtProposal : sideMid(mid, p.tokenId, m));
    if (reason && (await expire(d, p, reason)).ok) out.expired++;
  }
  return out;
}

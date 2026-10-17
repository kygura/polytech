import { autoAllowed, checkOrder, effectiveMode, exitDecision, gtdExpiry, livelimitPrice, proposalExpiry, type Mode } from "@pm/core";
import { schema as s } from "@pm/db";
import { scrub } from "@pm/pm";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, notExists, notInArray, notLike, sql } from "drizzle-orm";
import { safeEqual } from "../auth";
import { currentMode, downgradeOn } from "./autonomy";
import { today, withLock, type Deps } from "./deps";
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
export type Via = "web" | "tui" | "push" | "auto";
export const LIVE_MODES: Mode[] = ["L2", "L3", "L4"];
export const isLive = (m: Mode) => LIVE_MODES.includes(m);
/** UI state: db 'approved' is shown as 'sending' (DESIGN 8.7). */
export const uiState = (st: string) => (st === "approved" ? "sending" : st);

export const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
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

/** Latest reconciliation says mismatch, or a neg-risk set is flagged and not yet acknowledged => no new live orders. No recon row yet => not halted. */
export async function halted(d: Pick<Deps, "db">) {
  const r = (await d.db.select().from(s.reconciliations).orderBy(desc(s.reconciliations.id)).limit(1))[0];
  if (r && !r.ok) return true;
  return (await d.db.select({ id: s.proposalSets.id }).from(s.proposalSets).where(eq(s.proposalSets.status, "flagged")).limit(1)).length > 0;
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

export async function liveMode(d: Pick<Deps, "db" | "settings">, m: Row): Promise<Mode> {
  return effectiveMode(await currentMode(d.db), d.settings.overrides[m.category ?? ""]);
}

const FALLBACK: Record<string, string> = { STRUCTURAL_NOT_AUTO: "STRUCTURAL_AUTO_OFF", L3_PER_TRADE: "PER_TRADE", L3_DAILY_NOTIONAL: "DAILY_AUTO_NOTIONAL", CATEGORY_NOT_ALLOWED: "CATEGORY_NOT_ALLOWED" };
/** Notional of auto-sent orders created today (rejected/cancelled excluded). Read under the live-send lock so two auto sends cannot both pass the daily cap. */
async function autoToday(d: Pick<Deps, "db" | "now">) {
  const [r] = await d.db.select({ n: sql<number>`coalesce(sum(${s.orders.limitPrice} * ${s.orders.size}), 0)::float8` }).from(s.orders)
    .where(and(eq(s.orders.paper, false), eq(s.orders.approval, "auto"), eq(s.orders.side, "BUY"), gte(s.orders.createdAt, new Date(`${today(d.now())}T00:00:00Z`)), notInArray(s.orders.status, ["rejected", "cancelled"])));
  return r!.n;
}
/** null = may auto-send (L4 always; L3 inside limits.l3), else the DESIGN 9.3 fallback reason (needs approval). Callers only ask at L3/L4. */
export async function autoGate(d: Pick<Deps, "db" | "now" | "settings">, mode: Mode, o: { sizeUsd: number; category: string; isSet?: boolean }): Promise<string | null> {
  if (mode === "L4") return null;
  const r = autoAllowed(o, d.settings.limits.l3, await autoToday(d));
  return r.ok ? null : (FALLBACK[r.reason!] ?? r.reason!);
}

// ---------------------------------------------------------------- propose
/** L2+: every qualifying thesis becomes one proposal (no order yet), then exits for killed/flipped theses. L3 auto-sends inside limits.l3 and falls back to pending; L4 auto-sends. Risk against the live book only. */
export async function propose(d: Deps) {
  return withLock(d, "propose", 5 * MIN, async () => {
    const { db, settings: st } = d, now = d.now();
    const mode = await currentMode(db);
    const res = { mode, candidates: 0, proposed: 0, sent: 0, exits: 0, skipped: {} as Record<string, number> };
    if (!isLive(mode) || !d.exchange) return res;
    const skip = (r: string) => void (res.skipped[r] = (res.skipped[r] ?? 0) + 1);
    if (await halted(d)) return (skip("RECON_HALTED"), res);

    // held: open live position or live order on the market; theses with any non-expired entry proposal are done (rejected/failed are not re-proposed)
    const held = new Set((await openBook(db, false)).map((x) => x.p.conditionId));
    for (const o of await db.select({ c: s.orders.conditionId }).from(s.orders).where(and(eq(s.orders.paper, false), inArray(s.orders.status, LIVE_OPEN)))) held.add(o.c);
    const done = new Set((await db.select({ t: s.proposals.thesisId }).from(s.proposals).where(and(ne(s.proposals.status, "expired"), eq(s.proposals.kind, "entry")))).map((x) => x.t));
    // a category override lowers the mode per market: one candidate pass per live level up to the global mode
    const lv = await Promise.all(LIVE_MODES.slice(0, LIVE_MODES.indexOf(mode) + 1).map(async (m) => ({ m, ...(await candidates(d, m, held, mode)) })));
    const mk = lv[0]!.mk;
    const cands = lv.flatMap((x) => x.cands.map((t) => ({ t, m: x.m }))).filter((x) => !done.has(x.t.id)).sort((a, b) => (b.t.rank ?? 0) - (a.t.rank ?? 0));
    res.candidates = cands.length;
    if (cands.length) await takeSnapshots(d, cands.map((x) => x.t.conditionId)); // fresh book (< 60 s)
    const x = await exposureOf(db, st.bankroll, now, false);
    const dg = await downgradeOn(d, await downgradeSignals(d, x, cands.length)); // auto-downgrades: daily loss (live realized), stale feed
    if (dg) return { ...res, mode: dg };
    await cancelStaleEntries(d);
    res.exits = await proposeExits(d, mode, skip);
    if (!cands.length) return res;
    const snaps = await latestSnaps(db, cands.map((c) => c.t.conditionId));

    for (const { t, m: tmode } of cands) {
      const row = mk.get(t.conditionId)!;
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
      const category = row.category ?? "other";
      const chk = checkOrder({ sizeUsd, marketId: t.conditionId, eventId: eventOf(row), category }, x, st.limits);
      if (!chk.ok) { chk.violations.forEach((v) => skip(`RISK_${v.rule}`)); continue; }

      if ((await currentMode(db)) !== mode) { skip("MODE_CHANGED"); break; } // killed mid-run
      const fallbackReason = tmode === "L3" ? await autoGate(d, tmode, { sizeUsd, category }) : null;
      const ins = await insertProposal(d, { thesisId: t.id, conditionId: t.conditionId, tokenId, side: "BUY", kind: "entry", sizeUsd, shares, limitPrice: limit, expectedProfit: shares * sz.e, priceAtProposal: sz.pMid, fallbackReason }, row, t.side, now, tmode, mode, skip);
      if (ins === "break") break;
      if (!ins) continue;
      addExposure(x, row, sizeUsd); // later candidates in this run see this one
      res.proposed++;
      if (await autoSent(ins, d, tmode, fallbackReason)) res.sent++;
    }
    return res;
  });
}

type NewProposal = Pick<Proposal, "thesisId" | "conditionId" | "tokenId" | "side" | "kind" | "sizeUsd" | "shares" | "limitPrice" | "expectedProfit" | "priceAtProposal"> & Partial<Pick<Proposal, "fallbackReason" | "exitReason">>;
/** Insert a pending proposal (partial unique index: one pending per thesis). "break" = killed between the check and the insert (no push); undefined = duplicate. */
async function insertProposal(d: Deps, v: NewProposal, row: Row, side: string, now: number, tmode: Mode, top: Mode, skip: (r: string) => void) {
  const approve = newToken(), reject = newToken();
  let p: Proposal | undefined;
  try {
    [p] = await d.db.insert(s.proposals).values({ ...v, createdAt: new Date(now), expiresAt: new Date(now + TTL), approveTokenHash: sha256(approve), rejectTokenHash: sha256(reject) }).returning();
  } catch {
    skip("DUPLICATE_PENDING");
    return undefined;
  }
  if ((await currentMode(d.db)) !== top) { await expire(d, p!, "KILLED"); skip("MODE_CHANGED"); return "break" as const; }
  publish("proposal.created", { id: p!.id, conditionId: v.conditionId, kind: v.kind });
  return { p: p!, tk: { approve, reject }, question: row.question, side };
}
type Inserted = NonNullable<Awaited<ReturnType<typeof insertProposal>>> & object;

/** Auto-send a fresh proposal (L3 inside limits / L4); true = sent. Otherwise (L2, fallback, busy) it stays pending and the owner gets the approval push. */
async function autoSent({ p, tk, question, side }: Exclude<Inserted, string>, d: Deps, tmode: Mode, fallbackReason: string | null | undefined) {
  if (tmode !== "L2" && !fallbackReason) {
    const r = await decide(d, p.id, "approve", "auto");
    if (r.ok && r.state !== "pending") return r.state === "sent";
    if (!r.ok && r.error !== "busy") return false;
  }
  await notify(p, question, side, tk);
  return false;
}

/** Entry orders still resting for a killed thesis, or one superseded by a newer thesis (re-research): cancel the unfilled remainder. Failures stay live for the next run. */
async function cancelStaleEntries(d: Deps) {
  const open = await d.db.select().from(s.orders).where(and(eq(s.orders.paper, false), eq(s.orders.side, "BUY"), eq(s.orders.status, "live"), isNotNull(s.orders.clobOrderId), notLike(s.orders.thesisId, "set:%")));
  if (!open.length) return;
  const ths = await d.db.select().from(s.theses).where(inArray(s.theses.conditionId, [...new Set(open.map((o) => o.conditionId))])).orderBy(desc(s.theses.createdAt));
  const latest = new Map<string, string>();
  for (const t of ths) if (!latest.has(t.conditionId)) latest.set(t.conditionId, t.id);
  const filled = await liveFilled(d.db);
  for (const o of open) {
    const th = ths.find((t) => t.id === o.thesisId);
    if (!th || !(isKilled(th) || latest.get(o.conditionId) !== th.id)) continue;
    try {
      await d.exchange!.cancel([o.clobOrderId!]);
      await d.db.update(s.orders).set({ status: "cancelled" }).where(and(eq(s.orders.id, o.id), eq(s.orders.status, "live")));
      publish("order.updated", { id: o.id, orderId: o.clobOrderId, status: orderUi("cancelled", 0), filledShares: filled.get(o.id) ?? 0 });
    } catch { /* still live: retried next run */ }
  }
}
// ponytail: theses have no status column and no producer marks one killed yet; a kill-criteria checker writes detail.status = "killed"
const isKilled = (t: typeof s.theses.$inferSelect) => (t.detail as { status?: string } | null)?.status === "killed";

/**
 * Open live position (entered by a thesis) whose thesis was killed, or whose market's newest thesis flipped side => one exit proposal: SELL the whole position
 * at a floor of best bid - 0.02 (marketable GTD limit, never below one tick). One open exit per position (pending, approved, rejected, or a SELL order resting).
 * L2 pending; L3 auto inside limits.l3 (else fallback), L4 auto.
 */
async function proposeExits(d: Deps, top: Mode, skip: (r: string) => void) {
  const { db } = d, now = d.now();
  const book = await openBook(db, false);
  if (!book.length) return 0;
  const toks = book.map((x) => x.p.tokenId), conds = [...new Set(book.map((x) => x.p.conditionId))];
  const entries = await db.select().from(s.orders).where(and(eq(s.orders.paper, false), eq(s.orders.side, "BUY"), notLike(s.orders.thesisId, "set:%"), inArray(s.orders.tokenId, toks))).orderBy(desc(s.orders.createdAt));
  const ths = await db.select().from(s.theses).where(inArray(s.theses.conditionId, conds)).orderBy(desc(s.theses.createdAt));
  const exits = await db.select({ c: s.proposals.conditionId }).from(s.proposals).where(and(eq(s.proposals.kind, "exit"), inArray(s.proposals.status, ["pending", "approved", "rejected"]), inArray(s.proposals.conditionId, conds)));
  const selling = await db.select({ t: s.orders.tokenId }).from(s.orders).where(and(eq(s.orders.paper, false), eq(s.orders.side, "SELL"), inArray(s.orders.status, LIVE_OPEN), inArray(s.orders.tokenId, toks)));
  const busy = new Set([...exits.map((x) => x.c), ...selling.map((x) => x.t)]);

  const todo = book.flatMap(({ p, m }) => {
    const th = ths.find((t) => t.id === entries.find((o) => o.tokenId === p.tokenId)?.thesisId);
    if (!th || busy.has(p.conditionId) || busy.has(p.tokenId)) return [];
    const latest = ths.find((t) => t.conditionId === p.conditionId) ?? null;
    const dec = exitDecision({ status: isKilled(th) ? "killed" : "open", side: th.side }, latest, { shares: p.size });
    return dec.exit ? [{ p, m, th, reason: dec.reason! }] : [];
  });
  if (!todo.length) return 0;
  await takeSnapshots(d, todo.map((x) => x.p.conditionId));
  const snaps = await latestSnaps(db, todo.map((x) => x.p.conditionId));
  let n = 0;
  for (const { p, m, th, reason } of todo) {
    const tmode = await liveMode(d, m);
    if (!isLive(tmode)) continue;
    const sn = snaps.get(p.conditionId), yes = p.tokenId === m.yesTokenId;
    const bid = yes ? sn?.bestBid : sn?.bestAsk == null ? null : 1 - sn.bestAsk;
    if (bid == null || sn?.mid == null) { skip("NO_BOOK"); continue; }
    const limit = Math.max(TICK, Math.round(Math.floor(Math.round((bid - 0.02) / TICK * 1e6) / 1e6) * TICK * 1e8) / 1e8);
    const shares = Math.floor(p.size * SHARE_STEP) / SHARE_STEP;
    if (!(shares > 0)) continue;
    const sizeUsd = shares * limit;
    if ((await currentMode(db)) !== top) { skip("MODE_CHANGED"); break; }
    const fallbackReason = tmode === "L3" ? await autoGate(d, tmode, { sizeUsd, category: m.category ?? "other" }) : null;
    const ins = await insertProposal(d, {
      thesisId: th.id, conditionId: p.conditionId, tokenId: p.tokenId, side: "SELL", kind: "exit", sizeUsd, shares, limitPrice: limit, expectedProfit: shares * (bid - p.avgCost),
      priceAtProposal: sideMid(sn.mid, p.tokenId, m), fallbackReason, exitReason: reason,
    }, m, yes ? "YES" : "NO", now, tmode, top, skip);
    if (ins === "break") break;
    if (!ins) continue;
    n++;
    await autoSent(ins, d, tmode, fallbackReason);
  }
  return n;
}

/** POST one ntfy message. NTFY_TOPIC unset => skipped. Never throws (5 s timeout), so it never blocks the caller's real work. */
export async function ntfy(msg: { title: string; message: string; priority: number; actions?: unknown[] }, env = process.env, f: typeof fetch = fetch) {
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
  const mode = await liveMode(d, row);
  if (!d.exchange || !isLive(mode) || (via === "auto" && mode === "L2")) return { ok: false, error: "MODE" };
  if (await halted(d)) return { ok: false, error: "orders halted" };

  await takeSnapshots(d, [p.conditionId]); // fresh mid for the drift check
  const snap = (await latestSnaps(d.db, [p.conditionId])).get(p.conditionId);
  const now = d.now();
  const reason = proposalExpiry(p, new Date(now), snap?.mid == null ? NaN : sideMid(snap.mid, p.tokenId, row)) ?? (snap?.mid == null ? "PRICE_MOVED" : null); // no book = cannot prove the price held
  if (reason) return expire(d, p, reason);

  // approve-time price policy: recompute pPost on the fresh mid exactly as propose does; fail closed if it cannot be recomputed
  const exit = p.kind === "exit"; // a SELL of a held position: the entry thesis is dead by definition, and selling reduces risk
  if (!exit) {
    const th = (await d.db.select().from(s.theses).where(eq(s.theses.id, p.thesisId)))[0];
    const a = th ? assess(d, th, row, snap, now) : undefined;
    if (!a?.ok || livelimitPrice({ vwap: p.limitPrice, pPost: a.sz.pPost, tick: TICK }) == null) return expire(d, p, "PRICE_MOVED");
  }

  // Risk re-check -> CAS -> order insert -> place under one lock: two approvals cannot both pass the same caps. Held => busy, proposal stays pending.
  const r = await withLock(d, "live-send", 60_000, async (): Promise<Decision> => {
    // auto at L3: re-check the daily cap under the lock (two auto sends cannot both pass it); over => stays pending for manual approval
    if (via === "auto" && !exit && (await autoGate(d, mode, { sizeUsd: p.shares * p.limitPrice, category: row.category ?? "other" }))) return { ok: true, state: "pending" };
    const chk = exit ? { ok: true as const, violations: [] } : checkOrder({ sizeUsd: p.shares * p.limitPrice, marketId: p.conditionId, eventId: eventOf(row), category: row.category ?? "other" }, await exposureOf(d.db, d.settings.bankroll, now, false), d.settings.limits);
    if (!chk.ok) {
      const error = `risk: ${chk.violations.map((v) => v.rule).join(",")}`;
      if (!(await cas(d, p.id, "pending", { status: "failed", error, ...decided(d, via) }))) return { ok: false, error: "ALREADY_DECIDED" };
      updated(p, "failed", { error });
      return { ok: true, state: "failed", error };
    }
    if (!(await cas(d, p.id, "pending", { status: "approved", ...decided(d, via) }))) return { ok: false, error: "ALREADY_DECIDED" };
    updated(p, "approved");
    return send(d, p, mode, via);
  });
  return "skipped" in r ? { ok: false, error: "busy" } : r;
}

async function expire(d: Deps, p: Proposal, reason: "TIMEOUT" | "PRICE_MOVED" | "KILLED"): Promise<Decision> {
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
async function send(d: Deps, p: Proposal, mode: Mode, via: Via): Promise<Decision> {
  const fail = async (error: string, orderId?: string) => {
    if (await cas(d, p.id, "approved", { status: "failed", error, ...(orderId ? { orderId } : {}) })) updated(p, "failed", { error, ...(orderId ? { orderId } : {}) }); // lost CAS = sync already resolved it
    return { ok: true as const, state: "failed", error };
  };
  const now = d.now();
  const row = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, p.conditionId)))[0]!;
  const th = (await d.db.select().from(s.theses).where(eq(s.theses.id, p.thesisId)))[0];
  const expiresAt = gtdExpiry(p.kind === "exit" ? null : (th?.expiresAt ?? null), new Date(now)); // an exit does not depend on the (dead) thesis lifetime
  if (!th || !expiresAt) return fail("thesis expiring");

  // Double-send guard = the pending->approved CAS (one winner) + an order row written before place that is never re-sent while sending/unknown.
  // The (thesis, attempt) idempotency key below is an audit trail only, not the guard.
  const attempt = (await d.db.select({ n: sql<number>`count(*)::int` }).from(s.orders).where(and(eq(s.orders.thesisId, p.thesisId), eq(s.orders.paper, false))))[0]!.n;
  const orderId = `ord_${crypto.randomUUID().slice(0, 12)}`;
  try {
    await d.db.insert(s.orders).values({
      id: orderId, thesisId: p.thesisId, idempotencyKey: `${p.thesisId}:${attempt}`, attempt, paper: false, conditionId: p.conditionId, tokenId: p.tokenId,
      side: p.side, limitPrice: p.limitPrice, size: p.shares, modeAtSend: mode, approval: via === "auto" ? "auto" : "user", status: "sending", expiresAt, createdAt: new Date(now), proposalId: p.id,
    });
  } catch {
    return fail("duplicate order key: not sent"); // another send owns (thesis, attempt)
  }
  await d.db.update(s.proposals).set({ orderId }).where(eq(s.proposals.id, p.id));

  // kill/halt can land between the CAS and here: re-check right before the only exchange call
  const blocked = !isLive(await liveMode(d, row)) ? "KILLED" : (await halted(d)) ? "orders halted" : null;
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
  if (!isLive(await liveMode(d, row))) { // killed while place was in flight: pull the order back
    try {
      await d.exchange!.cancel([placed.orderId]);
      if (placed.status === "live") await d.db.update(s.orders).set({ status: "cancelled" }).where(eq(s.orders.id, orderId)); // matched stays for fill sync (may already be filled)
      return fail("KILLED", orderId);
    } catch (e) {
      return fail(`KILLED: cancel failed, order left for sync: ${scrub(e instanceof Error ? e.message : "cancel failed")}`.slice(0, 300), orderId);
    }
  }
  if (await cas(d, p.id, "approved", { status: "sent" })) updated(p, "sent", { orderId: placed.orderId });
  return { ok: true, state: "sent", orderId: placed.orderId };
}

// ---------------------------------------------------------------- expire
/** Pending proposals past 15 min, or whose side mid (latest snapshot) moved > 2c, become expired. 'approved' with no order for > 2 min (crash before the order row) fails as STUCK_APPROVED. */
export async function expireProposals(d: Deps) {
  const stuck = await d.db.update(s.proposals).set({ status: "failed", error: "STUCK_APPROVED" })
    .where(and(eq(s.proposals.status, "approved"), isNull(s.proposals.orderId),
      notExists(d.db.select({ x: sql`1` }).from(s.orders).where(and(eq(s.orders.proposalId, s.proposals.id)))), // an order row exists: sync owns it
      lt(s.proposals.decidedAt, new Date(d.now() - 2 * MIN)))).returning({ id: s.proposals.id });
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

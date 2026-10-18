import { rulesHash } from "@pm/agents";
import {
  ladderViolations, mirrorPairs, negRiskArb, pass1, screen, sortAsc, takerFeePerShare,
  type Pass1Reason, type Tier,
} from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { desc, eq, inArray, max, sql } from "drizzle-orm";
import { chunks, feeOf, groupBy, toMarket, toSnap, withLock, type Deps } from "./deps";
import { publish } from "./events";
import type { AppSettings } from "./settings";

const OPEN = ["active", "disputed", "not_accepting"];

export type StructDetail = {
  type: "neg-risk-sum" | "ladder" | "mirror";
  kind?: "buy-all" | "sell-all"; // neg-risk only
  lockedC: number; // fee-adjusted edge in cents (ladder/mirror: executable at the touch)
  sum: number | null; // neg-risk: sum of best asks (buy-all) or best bids (sell-all)
  legs: string[]; // conditionIds in the set
  sizeUsd: number; // min(capFrac*B, thinnest touch level on the legs)
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Deterministic stand-in when no LLM classifier is wired (fake/no key): cues in the rules text. */
export function heuristicR(rules: string): number {
  const r = rules.toLowerCase();
  let x = 0.3;
  if (/official|primary resolution source|source is/.test(r)) x += 0.25;
  if (/https?:\/\/|\.gov|\.org|data release|announce|published/.test(r)) x += 0.15;
  if (/\b(by|on|before)\b[^.]*\d{4}/.test(r)) x += 0.1;
  if (/discretion|subjective|ambiguous/.test(r)) x -= 0.2;
  return clamp01(x);
}

const stem = (q: string) => q.replace(/\s+(by|before)\s+.*$/i, "").toLowerCase().trim();
/** Mirror key: longest run of 3+ Capitalized words ("Federal Data Privacy Act"), else the whole question. ponytail: heuristic, misses paraphrases without a named entity. */
const mirrorKey = (q: string) => {
  const runs = q.replace(/^Will\s+/, "").match(/(?:[A-Z][\w&.-]*\s+){2,}[A-Z][\w&.-]*/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? q;
};

type SnapRow = typeof s.snapshots.$inferSelect;
/** Latest snapshot per condition. */
export const latestSnaps = async (db: Db, ids?: string[]) =>
  new Map(
    (await db.selectDistinctOn([s.snapshots.conditionId]).from(s.snapshots)
      .where(ids ? inArray(s.snapshots.conditionId, ids) : undefined)
      .orderBy(s.snapshots.conditionId, desc(s.snapshots.ts))).map((r) => [r.conditionId, r] as [string, SnapRow]),
  );

/** Neg-risk sums, ladders, mirrors over every open market with a book. First detector to claim a market wins. */
export function detectStructural(
  rows: { m: ReturnType<typeof toMarket>; snap: SnapRow }[], capUsd: number, groupSize?: Map<string, number>,
): Map<string, StructDetail> {
  const out = new Map<string, StructDetail>();
  const by = new Map(rows.map((r) => [r.m.conditionId, r]));
  const touch = (id: string, side: "asks" | "bids") => {
    const ls = sortAsc(by.get(id)!.snap.book?.[side] ?? []);
    const l = side === "asks" ? ls[0] : ls.at(-1);
    return l ? { price: l.price, usd: l.price * l.size } : null;
  };
  const size = (ids: string[], side: "asks" | "bids") => Math.min(capUsd, ...ids.map((i) => touch(i, side)?.usd ?? 0));
  const claim = (ids: string[], d: StructDetail) => ids.forEach((i) => out.has(i) || out.set(i, d));
  const mid = (id: string) => by.get(id)!.snap.mid ?? 0;

  const groups = groupBy(rows.filter((r) => r.m.negRiskGroup), (r) => r.m.negRiskGroup!);
  for (const legs of groups.values()) {
    if (legs.length < 2 || legs.some((l) => !l.snap.book?.asks.length || !l.snap.book.bids.length)) continue; // incomplete set => no arb claim
    const arb = negRiskArb(
      legs.map((l) => ({ conditionId: l.m.conditionId, bids: l.snap.book!.bids, asks: l.snap.book!.asks })),
      Math.max(...legs.map((l) => feeOf(l.m))),
    );
    if (!arb) continue;
    if (arb.kind === "buy-all" && legs.length !== (groupSize?.get(legs[0]!.m.negRiskGroup!) ?? legs.length)) continue; // buy-all needs every leg: a missing one may be the winner
    const side = arb.kind === "buy-all" ? "asks" : "bids";
    claim(arb.legs, {
      type: "neg-risk-sum", kind: arb.kind, lockedC: arb.edge * 100,
      sum: arb.legs.reduce((t, i) => t + (touch(i, side)?.price ?? 0), 0), legs: arb.legs, sizeUsd: size(arb.legs, side),
    });
  }

  const stems = groupBy(rows.filter((r) => stem(r.m.question) !== r.m.question.toLowerCase().trim() && r.snap.mid != null), (r) => stem(r.m.question));
  for (const g of stems.values()) {
    const v = ladderViolations(g.map((r) => ({ conditionId: r.m.conditionId, date: r.m.endDate, p: mid(r.m.conditionId) })), 0.02)
      .sort((a, b) => b.gap - a.gap)[0];
    if (!v) continue;
    const bid = touch(v.earlier, "bids"), ask = touch(v.later, "asks"); // sell the early rung, buy the late one
    if (!bid || !ask) continue;
    const fee = takerFeePerShare(feeOf(by.get(v.earlier)!.m), bid.price) + takerFeePerShare(feeOf(by.get(v.later)!.m), ask.price);
    const lockedC = (bid.price - ask.price - fee) * 100;
    if (lockedC <= 0) continue;
    claim([v.earlier, v.later], { type: "ladder", lockedC, sum: null, legs: [v.earlier, v.later], sizeUsd: Math.min(capUsd, bid.usd, ask.usd) });
  }

  const key = (id: string) => { const m = by.get(id)!.m; return `${mirrorKey(m.question)} ${new Date(m.endDate).toISOString().slice(0, 10)}`; }; // same entity, different question/date is not a mirror
  for (const p of mirrorPairs(rows.filter((r) => r.snap.mid != null).map((r) => ({ conditionId: r.m.conditionId, question: key(r.m.conditionId), p: r.snap.mid! })), 0.03)) {
    const [hi, lo] = mid(p.a) > mid(p.b) ? [p.a, p.b] : [p.b, p.a]; // sell the dear listing, buy the cheap one
    const bid = touch(hi, "bids"), ask = touch(lo, "asks");
    if (!bid || !ask) continue;
    const fee = takerFeePerShare(feeOf(by.get(hi)!.m), bid.price) + takerFeePerShare(feeOf(by.get(lo)!.m), ask.price);
    const lockedC = (bid.price - ask.price - fee) * 100;
    if (lockedC <= 0) continue;
    claim([hi, lo], { type: "mirror", lockedC, sum: null, legs: [hi, lo], sizeUsd: Math.min(capUsd, bid.usd, ask.usd) });
  }
  return out;
}

export const smallCapTooBusy = (tier: Tier, vol24h: number, structural: boolean, st: Pick<AppSettings, "universe">) =>
  tier === "small-cap" && !structural && vol24h > st.universe.smallCapMaxVol24hUsd;

const by = (rows: { m: { conditionId: string; eventId: string; negRiskGroup: string | null } }[], id: string) => rows.find((r) => r.m.conditionId === id)!.m;

export async function screenAll(d: Deps) {
  return withLock(d, "screen", 10 * 60_000, async () => {
    const now = d.now(), st = d.settings;
    const mrows = await d.db.select().from(s.markets).where(inArray(s.markets.status, OPEN));
    const snaps = await latestSnaps(d.db, mrows.map((m) => m.conditionId));
    const rows = mrows.flatMap((r) => { const snap = snaps.get(r.conditionId); return snap?.book ? [{ r, m: toMarket(r), snap }] : []; });
    // buy-all needs every leg and the db only holds the filtered universe: confirm the true leg count with Gamma, one call per flagged group; a failed lookup rejects (-1 never matches)
    const cap = st.capFrac * st.bankroll, dbSize = new Map([...groupBy(mrows.filter((r) => r.negRiskGroup), (r) => r.negRiskGroup!)].map(([g, v]) => [g, v.length]));
    const trueSize = new Map<string, number>();
    const flagged = [...detectStructural(rows, cap)].flatMap(([id, x]) => (x.type === "neg-risk-sum" && x.kind === "buy-all" ? [by(rows, id)] : []));
    for (const m of new Map(flagged.map((m) => [m.negRiskGroup!, m])).values())
      trueSize.set(m.negRiskGroup!, await d.pm.event(m.eventId).then((e) => (e ? e.markets.filter((x) => x.neg_risk_group === m.negRiskGroup).length : -1), () => -1));
    const structural = detectStructural(rows, cap, new Map([...dbSize, ...trueSize]));

    // pass 1 on everything; R (cached by rules hash) only for survivors and structural legs
    const filtered: Partial<Record<Pass1Reason, number>> = {};
    const alive = new Set<string>();
    for (const { m, snap } of rows) {
      const p = pass1(m, toSnap(snap), st, now);
      if (p.ok) alive.add(m.conditionId);
      else filtered[p.reason] = (filtered[p.reason] ?? 0) + 1;
    }
    const todo = rows.filter(({ m }) => alive.has(m.conditionId) || structural.has(m.conditionId));
    const cached = new Map((await d.db.select().from(s.rrCache)).map((c) => [`${c.conditionId}:${c.rulesHash}`, c]));
    const R = new Map<string, number>();
    const fresh: (typeof s.rrCache.$inferInsert)[] = [];
    for (const batch of chunks(todo, 10))
      await Promise.all(batch.map(async ({ m }) => {
        const h = rulesHash(m.rules), hit = cached.get(`${m.conditionId}:${h}`);
        if (hit && !((hit.detail as { fallback?: boolean } | null)?.fallback && d.rScore)) return void R.set(m.conditionId, hit.r);
        let r: number | undefined, fallback = false;
        try { r = d.rScore ? clamp01(await d.rScore(m.rules)) : undefined; } catch { /* outage: fall through */ }
        if (r === undefined) { r = heuristicR(m.rules); fallback = true; }
        R.set(m.conditionId, r);
        fresh.push({ conditionId: m.conditionId, rulesHash: h, r, detail: { fallback } });
      }));
    for (const f of fresh)
      await d.db.insert(s.rrCache).values(f).onConflictDoUpdate({ target: [s.rrCache.conditionId, s.rrCache.rulesHash], set: { r: f.r, detail: f.detail } });

    const out = todo.flatMap(({ m, snap }) => {
      const sc = screen({
        market: m, snap: toSnap(snap), R: R.get(m.conditionId)!, structural: structural.has(m.conditionId), settings: st, now,
        crowd: { top10Share: snap.top10Share ?? 0, netFlow: snap.book?.netFlow ?? 0, skew: 0 }, // ponytail: comment skew not wired
      });
      const d1 = structural.get(m.conditionId);
      if (smallCapTooBusy(sc.tier, snap.vol24h ?? 0, !!d1, st)) return []; // busy small-cap markets are already efficient; size tier and structural legs exempt
      return [{
        conditionId: m.conditionId, ts: new Date(now), r: sc.R, i: sc.I, l: sc.L, t: sc.T, c: sc.C,
        priority: alive.has(m.conditionId) ? sc.priority : 0, // structural-only legs fail pass 1: never shortlisted for research
        tier: sc.tier, structuralFlag: sc.structural, structuralDetail: d1 ?? null,
      } satisfies typeof s.screens.$inferInsert];
    });
    for (const c of chunks(out, 200)) await d.db.insert(s.screens).values(c);

    const list = await shortlist(d.db, 20);
    const res = {
      universe: rows.length, screened: out.length, passed: alive.size, filtered,
      structural: { negRisk: [...structural.values()].filter((x) => x.type === "neg-risk-sum").length, ladder: [...structural.values()].filter((x) => x.type === "ladder").length, mirror: [...structural.values()].filter((x) => x.type === "mirror").length },
      shortlist: { "small-cap": list.filter((x) => x.tier === "small-cap").length, size: list.filter((x) => x.tier === "size").length },
    };
    publish("screen.done", res);
    return res;
  });
}

/** Rows of the most recent screen run. */
export async function latestScreens(db: Db) {
  const [{ ts }] = await db.select({ ts: max(s.screens.ts) }).from(s.screens) as [{ ts: Date | null }];
  return ts ? db.select().from(s.screens).where(eq(s.screens.ts, ts)) : [];
}

/** Top `per` by priority in each tier (so 20-40 total), muted excluded, pinned always in. */
export async function shortlist(db: Db, per = 20): Promise<{ conditionId: string; tier: Tier; priority: number }[]> {
  const rows = await latestScreens(db);
  const flags = new Map((await db.select().from(s.marketFlags)).map((f) => [f.conditionId, f]));
  const n: Record<string, number> = {};
  return rows
    .filter((r) => !flags.get(r.conditionId)?.muted && (flags.get(r.conditionId)?.pinned || (r.priority ?? 0) > 0))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .filter((r) => flags.get(r.conditionId)?.pinned || (n[r.tier!] = (n[r.tier!] ?? 0) + 1) <= per)
    .map((r) => ({ conditionId: r.conditionId, tier: r.tier as Tier, priority: r.priority ?? 0 }));
}

/** Markets to poll every 5 min: latest screen run + live theses. undefined before the first screen (= poll all). */
export async function watchlistIds(d: Pick<Deps, "db" | "now">): Promise<string[] | undefined> {
  const run = await latestScreens(d.db);
  if (!run.length) return undefined;
  const th = await d.db.selectDistinct({ c: s.theses.conditionId }).from(s.theses).where(sql`${s.theses.expiresAt} > ${new Date(d.now())}`);
  return [...new Set([...run.map((r) => r.conditionId), ...th.map((t) => t.c)])];
}

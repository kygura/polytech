import { costUsd, modelFor } from "@pm/agents";
import {
  crowd, findStructural, mirrorPairs, pass1, screen, sizeTrade, sortAsc, structuralFlagsByMarket, takerFeePerShare,
  type Pass1Reason, type StructuralGroup, type StructuralKind, type StructuralMarket, type Tier,
} from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { and, desc, eq, gt, inArray, isNull, max, or, sql } from "drizzle-orm";
import { DAY, addSpend, chunks, feeExpOf, feeOf, groupBy, ruleText, toMarket, toSnap, today, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { memoClear } from "./memo";
import type { AppSettings } from "./settings";

/** Function limit is 300s and the reads alone take ~30s: stop issuing LLM batches at 170s, leaving room for ~8.5k row writes. */
const BUDGET_MS = 170_000;
/** ~30 batches of 10 (~1-2s each): a cold cache fills over several runs, best candidates first. */
const MAX_LLM = 300;
const GAMMA_CONC = 8;
// ponytail: classifyR usage is not returned, so charge a flat haiku estimate (~1.5k in / 0.4k out) per call against the daily cap.
const R_TIMEOUT_MS = 20_000; // hard bound per classifier call (the stub or SDK may hang)
const R_CALL_USD = costUsd(modelFor("r_classifier"), 1_500, 400);
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

/** Mirror key: longest run of 3+ Capitalized words ("Federal Data Privacy Act"), else the whole question. ponytail: heuristic, misses paraphrases without a named entity. */
const mirrorKey = (q: string) => {
  const runs = q.replace(/^Will\s+/, "").match(/(?:[A-Z][\w&.-]*\s+){2,}[A-Z][\w&.-]*/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? q;
};

type SnapRow = typeof s.snapshots.$inferSelect;
/**
 * Latest snapshot per condition. History rows are skipped while the book is unchanged, so the row's age is the newer of its own ts and
 * market_latest.ts (written every run, after the history row): "this book, last seen at".
 */
export const latestSnaps = async (db: Db, ids?: string[]) => {
  const [rows, seen] = await Promise.all([
    db.selectDistinctOn([s.snapshots.conditionId]).from(s.snapshots)
      .where(ids ? inArray(s.snapshots.conditionId, ids) : undefined)
      .orderBy(s.snapshots.conditionId, desc(s.snapshots.ts)),
    db.select({ c: s.marketLatest.conditionId, ts: s.marketLatest.ts }).from(s.marketLatest).where(ids ? inArray(s.marketLatest.conditionId, ids) : undefined),
  ]);
  const at = new Map(seen.map((x) => [x.c, x.ts]));
  return new Map(rows.map((r) => [r.conditionId, (at.get(r.conditionId)?.getTime() ?? 0) > r.ts.getTime() ? { ...r, ts: at.get(r.conditionId)! } : r] as [string, SnapRow]));
};

/** Neg-risk baskets, ladders, mirrors over every open market with a book. First detector to claim a market wins. `kinds`, when given, receives the core structural kinds (executable items only) each market is in. */
export function detectStructural(
  rows: { m: ReturnType<typeof toMarket>; snap: SnapRow }[], capUsd: number, groupSize?: Map<string, number>, kinds?: Map<string, StructuralKind[]>,
): Map<string, StructDetail> {
  const out = new Map<string, StructDetail>();
  const by = new Map(rows.map((r) => [r.m.conditionId, r]));
  const touch = (id: string, side: "asks" | "bids") => {
    const ls = sortAsc(by.get(id)!.snap.book?.[side] ?? []);
    const l = side === "asks" ? ls[0] : ls.at(-1);
    return l ? { price: l.price, usd: l.price * l.size, shares: l.size } : null;
  };
  const size = (ids: string[], side: "asks" | "bids") => Math.min(capUsd, ...ids.map((i) => touch(i, side)?.usd ?? 0));
  const claim = (ids: string[], d: StructDetail) => ids.forEach((i) => out.has(i) || out.set(i, d));
  const mid = (id: string) => by.get(id)!.snap.mid ?? 0;

  const sm = (r: (typeof rows)[number]): StructuralMarket => {
    const id = r.m.conditionId, bid = touch(id, "bids"), ask = touch(id, "asks");
    return {
      conditionId: id, question: r.m.question, endDate: r.m.endDate || null, mid: r.snap.mid ?? null, feeRate: feeOf(r.m), feeExponent: feeExpOf(r.m),
      bestBid: bid?.price ?? null, bidSize: bid?.shares ?? null, bestAsk: ask?.price ?? null, askSize: ask?.shares ?? null,
    };
  };
  // a leg missing from the db (filtered universe) may be the winner: the Σasks<1 lock needs the true leg count
  const groups: StructuralGroup[] = [...groupBy(rows.filter((r) => r.m.negRiskGroup), (r) => r.m.negRiskGroup!)].map(([g, legs]) => ({
    eventId: g, eventTitle: null, negRisk: true, negRiskAugmented: legs.some((l) => l.m.negRiskAugmented), hasInactiveMarkets: legs.length !== (groupSize?.get(g) ?? legs.length), markets: legs.map(sm),
  }));
  groups.push({ eventId: "*", eventTitle: null, negRisk: false, markets: rows.map(sm) }); // ladders are parsed from question text, across events
  const items = findStructural(groups).filter((it) => it.net > 0);
  if (kinds) for (const [id, ks] of structuralFlagsByMarket(items)) kinds.set(id, ks);
  for (const it of items.filter((x) => x.kind !== "monotonicity_violation")) {
    const side = it.side === "ask" ? "asks" : "bids";
    claim(it.conditionIds, {
      type: "neg-risk-sum", kind: it.side === "ask" ? "buy-all" : "sell-all", lockedC: it.net * 100,
      sum: it.conditionIds.reduce((t, i) => t + (touch(i, side)?.price ?? 0), 0), legs: it.conditionIds, sizeUsd: size(it.conditionIds, side),
    });
  }
  for (const it of items.filter((x) => x.kind === "monotonicity_violation")) {
    const [a, b] = it.conditionIds as [string, string];
    // sell the dear rung at its bid, buy the cheap one at its ask: only one orientation crosses
    const leg = [[a, b], [b, a]].map(([sell, buy]) => ({ sell: sell!, buy: buy!, bid: touch(sell!, "bids"), ask: touch(buy!, "asks") }))
      .find((x) => x.bid && x.ask && x.bid.price > x.ask.price);
    if (!leg) continue;
    claim([leg.sell, leg.buy], { type: "ladder", lockedC: it.net * 100, sum: null, legs: [leg.sell, leg.buy], sizeUsd: Math.min(capUsd, leg.bid!.usd, leg.ask!.usd) });
  }

  const key = (id: string) => { const m = by.get(id)!.m; return `${mirrorKey(m.question)} ${new Date(m.endDate).toISOString().slice(0, 10)}`; }; // same entity, different question/date is not a mirror
  for (const p of mirrorPairs(rows.filter((r) => r.snap.mid != null).map((r) => ({ conditionId: r.m.conditionId, question: key(r.m.conditionId), p: r.snap.mid! })), 0.03)) {
    const [hi, lo] = mid(p.a) > mid(p.b) ? [p.a, p.b] : [p.b, p.a]; // sell the dear listing, buy the cheap one
    const bid = touch(hi, "bids"), ask = touch(lo, "asks");
    if (!bid || !ask) continue;
    const fee = takerFeePerShare(feeOf(by.get(hi)!.m), bid.price, feeExpOf(by.get(hi)!.m)) + takerFeePerShare(feeOf(by.get(lo)!.m), ask.price, feeExpOf(by.get(lo)!.m));
    const lockedC = (bid.price - ask.price - fee) * 100;
    if (lockedC <= 0) continue;
    claim([hi, lo], { type: "mirror", lockedC, sum: null, legs: [hi, lo], sizeUsd: Math.min(capUsd, bid.usd, ask.usd) });
  }
  return out;
}

export const smallCapTooBusy = (tier: Tier, vol24h: number, structural: boolean, st: Pick<AppSettings, "universe">) =>
  tier === "small-cap" && !structural && vol24h > st.universe.smallCapMaxVol24hUsd;

const by = (rows: { m: { conditionId: string; eventId: string; negRiskGroup: string | null } }[], id: string) => rows.find((r) => r.m.conditionId === id)!.m;

export async function screenAll(d: Deps, opts: { budgetMs?: number; maxLlm?: number } = {}) {
  const t0 = Date.now(), o = { budgetMs: BUDGET_MS, maxLlm: MAX_LLM, ...opts };
  return withLock(d, "screen", 10 * 60_000, async () => {
    const now = d.now(), st = d.settings;
    const mrows = await d.db.select().from(s.markets).where(inArray(s.markets.status, OPEN));
    const snaps = await latestSnaps(d.db, mrows.map((m) => m.conditionId));
    const rows = mrows.flatMap((r) => { const snap = snaps.get(r.conditionId); return snap?.book ? [{ r, m: toMarket(r), snap }] : []; });
    // buy-all needs every leg and the db only holds the filtered universe: confirm the true leg count with Gamma, one call per flagged group; a failed lookup rejects (-1 never matches)
    const cap = st.capFrac * st.bankroll, dbSize = new Map([...groupBy(mrows.filter((r) => r.negRiskGroup), (r) => r.negRiskGroup!)].map(([g, v]) => [g, v.length]));
    const trueSize = new Map<string, number>();
    const flagged = [...detectStructural(rows, cap)].flatMap(([id, x]) => (x.type === "neg-risk-sum" && x.kind === "buy-all" ? [by(rows, id)] : []));
    // GAMMA_CONC lookups in flight (one at a time spent the whole budget on ~500 groups); the pm bucket still paces the host
    const lookups = [...new Map(flagged.map((m) => [m.negRiskGroup!, m])).values()];
    await Promise.all(Array.from({ length: GAMMA_CONC }, async () => {
      for (let m = lookups.shift(); m; m = lookups.shift())
        trueSize.set(m.negRiskGroup!, Date.now() - t0 > o.budgetMs / 2 ? -1 : await d.pm.event(m.eventId).then((e) => (e ? e.markets.filter((x) => x.neg_risk_group === m!.negRiskGroup).length : -1), () => -1));
    }));
    const kinds = new Map<string, StructuralKind[]>();
    const structural = detectStructural(rows, cap, new Map([...dbSize, ...trueSize]), kinds);

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
    const crowd = (snap: SnapRow) => ({ top10Share: snap.top10Share ?? 0, netFlow: snap.book?.netFlow ?? 0, skew: 0 }); // ponytail: comment skew not wired
    const score = ({ m, snap }: Pick<(typeof todo)[number], "m" | "snap">, r: number) =>
      screen({ market: m, snap: toSnap(snap), R: r, structural: structural.has(m.conditionId), settings: st, now, crowd: crowd(snap) });
    const hR = (x: (typeof todo)[number]) => x.r.heuristicR ?? heuristicR(""); // scored by the sweep; rows swept before heuristic_r existed take the base score
    const need: typeof todo = [];
    for (const x of todo) {
      const hit = cached.get(`${x.m.conditionId}:${x.r.rulesHash ?? ""}`);
      if (hit && !((hit.detail as { fallback?: boolean } | null)?.fallback && d.rScore)) R.set(x.m.conditionId, hit.r);
      else need.push(x);
    }
    const sp = d.rScore ? (await d.db.select().from(s.spend).where(eq(s.spend.day, today(now))))[0] : undefined;
    const capped = (sp?.anthropicUsd ?? 0) >= st.budget.dailySpendCapUsd; // daily spend cap hit: heuristic only
    // LLM budget: best heuristic-priority first, capped per run and by wall clock (function limit 300s, reads included); the rest take the heuristic and are retried next run
    const first = d.rScore && !capped ? need.map((x) => [x, +alive.has(x.m.conditionId) * 10 + score(x, hR(x)).priority] as const).sort((a, b) => b[1] - a[1]).slice(0, o.maxLlm).map(([x]) => x) : d.rScore ? [] : need;
    let llm = 0;
    for (const batch of chunks(first, d.rScore ? 10 : 200)) {
      if (Date.now() - t0 > o.budgetMs) break;
      const fresh: (typeof s.rrCache.$inferInsert)[] = [];
      await Promise.all(batch.map(async (x) => {
        const { m, r: row } = x;
        let r: number | undefined, fallback = false;
        let tm: ReturnType<typeof setTimeout> | undefined;
        try {
          const rules = d.rScore ? await ruleText(d.pm, row) : undefined; // the db keeps only the hash: fetch the text for the markets actually classified
          r = rules ? clamp01(await Promise.race([d.rScore!(rules, t0 + o.budgetMs), new Promise<never>((_, no) => (tm = setTimeout(() => no(new Error("R timeout")), R_TIMEOUT_MS)))])) : undefined;
        } catch { /* outage/timeout: fall through */ } finally { clearTimeout(tm); }
        if (r === undefined) { r = hR(x); fallback = true; }
        R.set(m.conditionId, r);
        fresh.push({ conditionId: m.conditionId, rulesHash: row.rulesHash ?? "", r, detail: { fallback } });
      }));
      await d.db.insert(s.rrCache).values(fresh).onConflictDoUpdate({ target: [s.rrCache.conditionId, s.rrCache.rulesHash], set: { r: sql`excluded.r`, detail: sql`excluded.detail` } });
      if (d.rScore) { llm += batch.length; await addSpend(d.db, now, batch.length * R_CALL_USD, 0); }
    }
    for (const x of need) if (!R.has(x.m.conditionId)) R.set(x.m.conditionId, hR(x));
    console.log(`screen: R by llm/attempted=${llm} cached=${todo.length - need.length} heuristic-only=${need.length - first.length}`);

    const out = todo.flatMap(({ m, snap }) => {
      const sc = score({ m, snap }, R.get(m.conditionId)!);
      const d1 = structural.get(m.conditionId);
      if (smallCapTooBusy(sc.tier, snap.vol24h ?? 0, !!d1, st)) return []; // busy small-cap markets are already efficient; size tier and structural legs exempt
      return [{
        conditionId: m.conditionId, ts: new Date(now), r: sc.R, i: sc.I, l: sc.L, t: sc.T, c: sc.C,
        priority: alive.has(m.conditionId) ? sc.priority : 0, // structural-only legs fail pass 1: never shortlisted for research
        tier: sc.tier, structuralFlag: sc.structural, structuralDetail: d1 ?? null,
      } satisfies typeof s.screens.$inferInsert];
    });
    // all-or-nothing: latestScreens reads max(ts), so a partial insert would become the truncated "latest" screen.
    const parts = chunks(out, 500);
    await d.db.transaction(async (tx) => { for (const c of parts) await tx.insert(s.screens).values(c); });

    // market_latest carries the screen output for the DSL / screener: priority, structural kinds, opportunity (sized live theses). Derived data: a failure here must not lose the screens above.
    let latest = true;
    try {
      await writeLatest(d, rows, out, kinds, now);
    } catch (e) {
      latest = false;
      console.warn("screen: market_latest write failed:", String((e as Error)?.message ?? e).slice(0, 160));
    }
    memoClear("watch:");

    const list = await shortlist(d.db, 20);
    const res = {
      marketLatest: latest,
      universe: rows.length, screened: out.length, passed: alive.size, filtered,
      structural: { negRisk: [...structural.values()].filter((x) => x.type === "neg-risk-sum").length, ladder: [...structural.values()].filter((x) => x.type === "ladder").length, mirror: [...structural.values()].filter((x) => x.type === "mirror").length },
      shortlist: { "small-cap": list.filter((x) => x.tier === "small-cap").length, size: list.filter((x) => x.tier === "size").length },
    };
    publish("screen.done", res);
    return res;
  });
}

type Opportunity = NonNullable<(typeof s.marketLatest.$inferInsert)["opportunity"]>;

/** Sizing of every live thesis against the stored book (both sides, fees per level, exit depth, 24h flow, extremize). Only rows that would trade (stake > 0). */
async function opportunities(d: Deps, rows: { m: ReturnType<typeof toMarket>; snap: SnapRow }[], now: number) {
  const th = await d.db.select().from(s.theses).where(or(isNull(s.theses.expiresAt), sql`${s.theses.expiresAt} > ${new Date(now)}`)).orderBy(desc(s.theses.createdAt));
  const latest = new Map<string, (typeof th)[number]>();
  for (const t of th) if (!latest.has(t.conditionId)) latest.set(t.conditionId, t);
  if (!latest.size) return new Map<string, Opportunity>();
  const flow = new Map((await d.db.select({ c: s.marketLatest.conditionId, f: s.marketLatest.flow24h }).from(s.marketLatest)).map((r) => [r.c, r.f]));
  const out = new Map<string, Opportunity>();
  for (const { m, snap } of rows) {
    const t = latest.get(m.conditionId), pYes = (t?.detail as { pYes?: number } | null | undefined)?.pYes;
    if (!t || pYes == null || snap.mid == null || !snap.book) continue;
    const cr = crowd({ top10Share: snap.top10Share ?? 0, netFlow: snap.book.netFlow, skew: 0 });
    const z = sizeTrade({
      bids: snap.book.bids, asks: snap.book.asks, pMid: snap.mid, pHat: pYes, c: t.c, daysLeft: (m.endDate - now) / DAY, feeRate: feeOf(m), feeExponent: feeExpOf(m),
      crowdC: cr.c, crowdSide: cr.side, settings: d.settings, flow24h: flow.get(m.conditionId) ?? null, extremize: d.settings.extremize,
    });
    if (z && z.sizeUsd > 0) out.set(m.conditionId, { side: z.side, edge: z.e, stake: z.sizeUsd, o: z.rank, contrarian: z.contrarian });
  }
  return out;
}

/** priority / structural / opportunity onto existing market_latest rows; rows that were set before and are not in this screen are cleared. */
async function writeLatest(d: Deps, rows: { m: ReturnType<typeof toMarket>; snap: SnapRow }[], out: (typeof s.screens.$inferInsert)[], kinds: Map<string, StructuralKind[]>, now: number) {
  const ml = s.marketLatest, opp = await opportunities(d, rows, now);
  const pr = new Map(out.map((x) => [x.conditionId, x.priority ?? null]));
  const have = await d.db.select({ c: ml.conditionId, p: ml.priority, st: ml.structural, o: ml.opportunity }).from(ml);
  const upd: (typeof ml.$inferInsert)[] = [], clear: string[] = [];
  for (const h of have) {
    const hit = pr.has(h.c) || opp.has(h.c);
    if (hit) upd.push({ conditionId: h.c, priority: pr.get(h.c) ?? null, structural: kinds.get(h.c) ?? [], opportunity: opp.get(h.c) ?? null });
    else if (h.p != null || h.st != null || h.o != null) clear.push(h.c);
  }
  for (const c of chunks(upd, 500))
    await d.db.insert(ml).values(c).onConflictDoUpdate({ target: ml.conditionId, set: { priority: sql`excluded."priority"`, structural: sql`excluded."structural"`, opportunity: sql`excluded."opportunity"` } });
  for (const c of chunks(clear, 5000)) await d.db.update(ml).set({ priority: null, structural: null, opportunity: null }).where(inArray(ml.conditionId, c));
}

/** Rows of the most recent screen run (~16k at full universe): narrow with `ids` / `structural` when only a few are needed. */
export async function latestScreens(db: Db, o: { ids?: string[]; structural?: boolean } = {}) {
  if (o.ids && !o.ids.length) return [];
  const [{ ts }] = await db.select({ ts: max(s.screens.ts) }).from(s.screens) as [{ ts: Date | null }];
  return ts ? db.select().from(s.screens).where(and(eq(s.screens.ts, ts), o.ids ? inArray(s.screens.conditionId, o.ids) : undefined, o.structural ? eq(s.screens.structuralFlag, true) : undefined)) : [];
}

/** Top `per` by priority in each tier (so 20-40 total), muted excluded, pinned always in. */
export async function shortlist(db: Db, per = 20): Promise<{ conditionId: string; tier: Tier; priority: number }[]> {
  const flags = new Map((await db.select().from(s.marketFlags)).map((f) => [f.conditionId, f]));
  const [{ ts }] = await db.select({ ts: max(s.screens.ts) }).from(s.screens) as [{ ts: Date | null }];
  if (!ts) return [];
  const pinned = [...flags.values()].filter((f) => f.pinned).map((f) => f.conditionId);
  // three narrow columns, priority > 0 or pinned: the full rows of a 16k-market run are too heavy to load per request
  const rows = await db.select({ conditionId: s.screens.conditionId, tier: s.screens.tier, priority: s.screens.priority }).from(s.screens)
    .where(and(eq(s.screens.ts, ts), or(gt(s.screens.priority, 0), pinned.length ? inArray(s.screens.conditionId, pinned) : undefined)));
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

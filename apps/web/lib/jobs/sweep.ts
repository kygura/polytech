import { rulesHash } from "@pm/agents";
import { bookHash, bookMetrics, classifyResolutionSource, holderMetrics, tradeMetrics, type TradeInput } from "@pm/core";
import { insertSnapshots, pruneSnapshots, schema as s } from "@pm/db";
import type { Market as PmMarket, Trade } from "@pm/pm";
import { and, eq, gte, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { KICK_AT } from "../public";
import { chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { monitor } from "./monitor";
import { heuristicR, shortlist, watchlistIds } from "./screen";

const MAX_FEE_FETCHES = 200;
const WALK_BUDGET_MS = 150_000; // the cron route allows 300 s: walk <= 150 s (+ one page), fees <= FEE_DEADLINE_MS, then closing
const FEE_DEADLINE_MS = 240_000; // from sweep start; remaining fee fetches are skipped (next sweep)
const OPEN = ["active", "disputed", "not_accepting"];
const ex = (c: { name: string }) => sql.raw(`excluded."${c.name}"`);

const statusOf = (m: PmMarket) => (!m.open ? "closed" : m.in_dispute ? "disputed" : !m.accepting_orders ? "not_accepting" : "active");

/** Gamma fee schedule rate (`rate * (p(1-p))^exponent`); feesEnabled=false is a real 0; no info = null (category fallback). The exponent is stored beside it (null = 1). */
const feeOfPm = (m: PmMarket) => m.fee_schedule?.rate ?? (m.fees_enabled === false ? 0 : null);
const feeExpOfPm = (m: PmMarket) => m.fee_schedule?.exponent ?? null;

/** `prev` = what the db already holds: an unchanged rules hash keeps the stored resolution source instead of re-running the classifier. */
export const toMarketRow = (m: PmMarket, prev?: { rulesHash: string | null; resolutionSource: string | null }): typeof s.markets.$inferInsert => {
  const rules = m.rules ?? "", hash = rulesHash(rules);
  return {
    conditionId: m.condition_id,
    eventId: m.event_id ?? null,
    question: m.question,
    category: m.category ?? null,
    tags: m.tags,
    endDate: m.end_date ? new Date(m.end_date) : null,
    negRiskGroup: m.neg_risk ? (m.neg_risk_group ?? null) : null,
    feeRate: feeOfPm(m), // null = unknown: the upsert keeps the stored rate, then the capped clob-markets lookup fills it
    feeExponent: feeExpOfPm(m),
    status: statusOf(m),
    pmId: m.id,
    yesTokenId: m.yes_token_id ?? null,
    noTokenId: m.no_token_id ?? null,
    vol24h: m.volume_24h ?? null,
    tickSize: m.tick_size ?? null,
    liquidity: m.liquidity ?? null,
    rulesHash: hash,
    heuristicR: heuristicR(rules), // rules text is not stored (~1.3 KB a market): score it here, fetch it again only to classify or research
    resolutionSource: prev?.rulesHash === hash && prev.resolutionSource ? prev.resolutionSource : classifyResolutionSource(m.question, rules, m.resolution_source),
    negRiskAugmented: m.neg_risk_augmented,
  };
};

const t = s.markets;
/** liquidity / volume churn every minute: rewrite only when the value moved > 5% (or appeared). */
const moved = (c: { name: string }) =>
  sql`(excluded."${sql.raw(c.name)}" is not null and (${sql.raw(`"markets"."${c.name}"`)} is null or abs(excluded."${sql.raw(c.name)}" - ${sql.raw(`"markets"."${c.name}"`)}) > 0.05 * greatest(abs(${sql.raw(`"markets"."${c.name}"`)}), 1)))`;
const stored = (c: { name: string }) => sql.raw(`"markets"."${c.name}"`);
// the columns whose change justifies a write. rules is covered by rules_hash. fee_rate / fee_exponent compare the coalesced value, tick_size too.
const SAME = [t.eventId, t.question, t.category, t.tags, t.endDate, t.negRiskGroup, t.status, t.pmId, t.yesTokenId, t.noTokenId, t.rulesHash, t.heuristicR, t.resolutionSource, t.negRiskAugmented];
const changed = sql`((${sql.join(SAME.map(stored), sql`, `)}, ${stored(t.tickSize)}, ${stored(t.feeRate)}, ${stored(t.feeExponent)}) is distinct from (${sql.join(SAME.map(ex), sql`, `)}, coalesce(excluded."tick_size", ${stored(t.tickSize)}), coalesce(excluded."fee_rate", ${stored(t.feeRate)}), coalesce(excluded."fee_exponent", ${stored(t.feeExponent)})) or ${moved(t.liquidity)} or ${moved(t.vol24h)})`;

/** Insert-or-update a page of markets; rows whose meaningful columns are unchanged are not written (not returned either). Returns the written condition ids. */
export async function upsertMarkets(db: Deps["db"], rows: (typeof s.markets.$inferInsert)[]): Promise<string[]> {
  if (!rows.length) return [];
  const out = await db.insert(t).values(rows).onConflictDoUpdate({
    target: t.conditionId,
    set: {
      eventId: ex(t.eventId), question: ex(t.question), category: ex(t.category), tags: ex(t.tags),
      endDate: ex(t.endDate), negRiskGroup: ex(t.negRiskGroup), status: ex(t.status), pmId: ex(t.pmId),
      yesTokenId: ex(t.yesTokenId), noTokenId: ex(t.noTokenId), rulesHash: ex(t.rulesHash), heuristicR: ex(t.heuristicR), resolutionSource: ex(t.resolutionSource), negRiskAugmented: ex(t.negRiskAugmented),
      vol24h: sql`case when ${moved(t.vol24h)} then excluded."vol_24h" else ${stored(t.vol24h)} end`,
      liquidity: sql`case when ${moved(t.liquidity)} then excluded."liquidity" else ${stored(t.liquidity)} end`,
      tickSize: sql`coalesce(excluded."tick_size", ${stored(t.tickSize)})`,
      feeRate: sql`coalesce(excluded."fee_rate", ${stored(t.feeRate)})`,
      feeExponent: sql`coalesce(excluded."fee_exponent", ${stored(t.feeExponent)})`,
    },
    setWhere: changed,
  }).returning({ id: t.conditionId });
  return out.map((r) => r.id);
}

/** pm universe (markets + events) -> `markets` upsert. Fee rate fetched once per new market (null = unknown -> category fallback at use). */
export async function sweepUniverse(d: Deps) {
  return withLock(d, "sweep", 10 * 60_000, async () => {
    // markets only: each carries its event id and neg-risk group; the events walk is ~1.7 GB of nested markets (OOM on Vercel)
    // and only the screenable slice: ~250k markets are open, ~26k have liquidity >= minLiquidityUsd and resolve within minDays..maxDays (server-side filters)
    const { minDays, maxDays } = d.settings.filters, liquidityMin = d.settings.universe.minLiquidityUsd, now = d.now();
    const endMin = now + minDays * 864e5, endMax = now + maxDays * 864e5;
    const known = new Map((await d.db.select({ id: t.conditionId, fee: t.feeRate, status: t.status, end: t.endDate, pmId: t.pmId, rulesHash: t.rulesHash, resolutionSource: t.resolutionSource }).from(t)).map((r) => [r.id, r]));
    const t0 = Date.now();
    // stream: upsert each page and keep only ids (+ condition for fee fetches), never the ~26k full markets (OOM on Vercel)
    const seen = new Set<string>(), needFee: string[] = [];
    let newMarkets = 0, written = 0;
    const { complete, pages } = await d.pm.walkMarkets({ liquidityMin, endDateMin: new Date(endMin).toISOString(), endDateMax: new Date(endMax).toISOString(), budgetMs: WALK_BUDGET_MS }, async (page) => {
      const rows = [...new Map(page.map((m) => [m.condition_id, m])).values()].map((m) => toMarketRow(m, known.get(m.condition_id)));
      if (!rows.length) return;
      written += (await upsertMarkets(d.db, rows)).length;
      for (const r of rows) {
        if (seen.has(r.conditionId)) continue;
        seen.add(r.conditionId);
        if (!known.has(r.conditionId)) newMarkets++;
        if (r.feeRate == null && r.yesTokenId && known.get(r.conditionId)?.fee == null) needFee.push(r.conditionId);
      }
    });
    if (!complete) console.warn(`sweep: listing incomplete after ${pages} pages (429/5xx/time budget), ${seen.size} markets upserted, closing skipped`);
    if (!seen.size) return { markets: 0, newMarkets: 0, written: 0, feesFetched: 0, closed: 0, complete };

    // fees after the upsert (a first run must not block on thousands of fetches); capped per run, the rest next sweep.
    // Gamma's feeSchedule already filled most rows; the rest ask the CLOB market info (its `fd` curve is authoritative, no `fd` = fee-free). /fee-rate is legacy and not used.
    const need = needFee.sort(() => Math.random() - 0.5).slice(0, MAX_FEE_FETCHES); // shuffle: failing markets must not starve the rest
    let feesFetched = 0;
    for (const batch of chunks(need, 20)) {
      if (Date.now() - t0 > FEE_DEADLINE_MS) break;
      await Promise.all(batch.map(async (c) => {
        const info = await d.pm.clobMarket(c).catch(() => undefined);
        if (!info) return; // 404 / outage: stays unknown, retried next sweep
        feesFetched++;
        await d.db.update(t).set({ feeRate: info.fee_schedule?.rate ?? 0, feeExponent: info.fee_schedule?.exponent ?? null }).where(eq(t.conditionId, c));
      }));
    }

    // open in db but gone from the open universe => closed (calibrateNightly decides if it resolved)
    // a truncated listing would mass-close live markets: skip when far fewer came back than we know are open
    // the listing is filtered: a missing market is closed only if its end date passed, or it sits inside the queried range (endMin..endMax) and could have been returned.
    // Ending soon (now..endMin), later, or undated fall out by the filter, not by closing, so they stay open. ponytail: a liquidity drop below the floor closes early; the upsert reopens it when it returns.
    const knownOpen = [...known].filter(([, r]) => {
      const end = r.end?.getTime();
      return OPEN.includes(r.status) && end != null && (end < now || (end >= endMin && end <= endMax));
    });
    // truncated listing = drops >10% vs the previous sweep's listing (not vs db open count, which a real mass resolution would lock out).
    // A shrink is honoured (close + new baseline) only after 3 consecutive shrunken sweeps; a normal sweep resets the counter.
    // baselines are keyed by the filter: a changed filter returns a different universe size and must start fresh, not look truncated
    const q = `${liquidityMin}:${minDays}:${maxDays}`, listingKey = `sweep:listing:${q}`, shrinkKey = `sweep:shrink:${q}`;
    const prev = await d.kv.get<number>(listingKey);
    const shrunk = !complete || (prev != null && seen.size < 0.9 * prev); // a listing cut short by a 429 / the time budget is truncated by definition
    const streak = shrunk && complete ? ((await d.kv.get<number>(shrinkKey)) ?? 0) + 1 : 0;
    const truncated = shrunk && (!complete || streak < 3);
    if (truncated) console.warn(`sweep: listing truncated (${seen.size} vs previous ${prev}, complete=${complete}, pages=${pages}, ${streak}/3), skipping close`);
    if (complete) await d.kv.set(shrinkKey, truncated ? streak : 0);
    if (!truncated) await d.kv.set(listingKey, seen.size);
    // a market we hold, or one in a pending proposal / unsettled set, closes only when Gamma says it is closed (resolution still needs the flip);
    // merely falling out of the filter, or a failed lookup, keeps it open so snapshots and exits keep running
    const held = new Set([
      ...(await d.db.select({ c: s.positions.conditionId }).from(s.positions).where(isNull(s.positions.closedAt))).map((r) => r.c),
      ...(await d.db.select({ c: s.proposals.conditionId }).from(s.proposals).where(inArray(s.proposals.status, ["pending", "approved"]))).map((r) => r.c),
      ...(await d.db.select({ c: s.pods.conditionId }).from(s.pods).where(gte(s.pods.startedAt, new Date(now - 30 * 864e5)))).map((r) => r.c), // researched (e.g. searched-and-ingested) markets stay open too
      ...(await d.db.select({ l: s.proposalSets.legs }).from(s.proposalSets).where(inArray(s.proposalSets.status, ["pending", "sending", "unwinding", "flagged"]))).flatMap((r) => r.l.map((l) => l.conditionId)),
    ]);
    const missing = truncated ? [] : knownOpen.filter(([id]) => !seen.has(id));
    const stillOpen = new Set((await Promise.all(missing.filter(([id]) => held.has(id)).map(async ([id, r]) => ((await d.pm.market(r.pmId ?? id).catch(() => undefined))?.open !== false ? id : null)))).flatMap((id) => id ?? []));
    const gone = missing.map(([id]) => id).filter((id) => !stillOpen.has(id));
    for (const c of chunks(gone, 500)) await d.db.update(t).set({ status: "closed" }).where(inArray(t.conditionId, c));

    const out = { markets: seen.size, newMarkets, written, feesFetched, closed: gone.length, complete };
    await d.kv.set(KICK_AT, Date.now()); // public sweptAt/stale detection, also covers cron sweeps
    publish("sweep.done", out);
    return out;
  });
}

const BOOK_LEVELS = 40; // ponytail: per side, bounds snapshot row size; sizing never walks deeper than this in practice
const BOOK_WINDOW = 0.1; // stored levels: within 10c of the touch (metrics come from the full book; sizing at our caps stops long before 10c)
const HISTORY_EVERY_MS = 3_600_000; // an unchanged book still gets one history row per hour (chart resolution, staleness proof)
const MID_MOVE = 0.01; // market_latest.mid_changed_at bumps when the mid moves >= 1c between runs
const CROWD_MAX = 200; // holders + trades are fetched for at most this many markets per run ...
const CROWD_TOP = 100; // ... the top-priority ones (researched markets first) always, the other slots rotate
const TRADES_CHUNK = 5; // markets per trades call (busy markets would crowd quiet ones out of a shared row cap)
const TRADES_CAP = 1000; // rows per call; hitting it means the 24h window is incomplete
const fnv = (str: string) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193); return h >>> 0; };
const CROWD_DEADLINE_MS = 120_000; // from the start of the run: remaining crowd chunks are skipped (their markets keep the previous values)
const CROWD_WAVE = 4; // concurrent data-API chunks
const OI_CHUNK = 20; // Data API v2 /oi: "condition accepts at most 20 distinct values" (50 got a 400 on every chunk)

const ml = s.marketLatest;
const keep = (c: { name: string }) => sql`coalesce(excluded."${sql.raw(c.name)}", ${sql.raw(`"market_latest"."${c.name}"`)})`;

/** Rows of `select ... where id in (ids)` for long id lists: undefined ids = no filter (one query). */
const byIds = async <R>(ids: string[] | undefined, q: (ids?: string[]) => Promise<R[]>) => (ids ? (await Promise.all(chunks(ids, 5000).map((c) => q(c)))).flat() : q());

/**
 * Snapshot `ids` (default: every open market). market_latest is upserted in place every run; a history row (`snapshots`) is appended
 * only when the book changed or the last one is older than an hour. Not locked: callers lock.
 */
export async function takeSnapshots(d: Deps, ids?: string[]) {
  const t0 = Date.now();
  const mkts = await d.db.select({ conditionId: s.markets.conditionId, yesTokenId: s.markets.yesTokenId, noTokenId: s.markets.noTokenId, vol24h: s.markets.vol24h, liquidity: s.markets.liquidity })
    .from(s.markets).where(and(inArray(s.markets.status, OPEN), isNotNull(s.markets.yesTokenId), ids ? inArray(s.markets.conditionId, ids) : undefined));
  if (!mkts.length) return { markets: 0, snapshots: 0, latest: 0, unchanged: 0, noBook: 0 };
  const conds = mkts.map((m) => m.conditionId);
  const now = d.now();

  // OI and trades are enrichment: a failing chunk (e.g. the data API's Cloudflare 403) leaves those markets without oi/flow, books still land.
  // Only pm client failures ("GET /oi -> 403 ...", "GET /oi -> network ...") are soft; anything else (TypeError, ...) is a bug and rethrows.
  // Chunks run in small waves so the deadline can stop the rest; chunks not run count as failed.
  const soft = async <X, T>(what: string, xs: X[], fn: (x: X) => Promise<T>, deadline = Infinity) => {
    const ok: T[] = [], failed: X[] = [];
    let bad: PromiseRejectedResult | undefined, skipped = 0;
    for (const wave of chunks(xs, CROWD_WAVE)) {
      if (Date.now() - t0 > deadline) { failed.push(...wave); skipped += wave.length; continue; }
      const rs = await Promise.allSettled(wave.map(fn));
      rs.forEach((r, i) => (r.status === "fulfilled" ? ok.push(r.value) : (failed.push(wave[i]!), (bad ??= r))));
    }
    if (bad && !/^(GET|POST) \S+ -> (\d{3}|network )/.test(String(bad.reason?.message ?? bad.reason))) throw bad.reason;
    if (failed.length) console.warn(`snapshot: ${what} failed for ${failed.length}/${xs.length} chunks (${skipped} past the deadline)${bad ? `: ${String(bad.reason).slice(0, 120)}` : ""}`);
    return { ok, failed };
  };
  const [books, oiParts, prevRows, histRows, researched] = await Promise.all([
    d.pm.books(mkts.map((m) => m.yesTokenId!)),
    soft("oi", chunks(conds, OI_CHUNK), (c) => d.pm.oi(c)),
    byIds(ids && conds, (c) => d.db.select().from(ml).where(c ? inArray(ml.conditionId, c) : undefined)),
    byIds(ids && conds, (c) => d.db.select({ c: s.snapshots.conditionId, ts: max(s.snapshots.ts) }).from(s.snapshots).where(c ? inArray(s.snapshots.conditionId, c) : undefined).groupBy(s.snapshots.conditionId)),
    d.db.selectDistinct({ c: s.theses.conditionId }).from(s.theses),
  ]);
  const book = new Map(books.map((b) => [b.token_id, b]));
  const oi: Record<string, number> = Object.assign({}, ...oiParts.ok);
  const prev = new Map(prevRows.map((r) => [r.conditionId, r])), lastHist = new Map(histRows.map((r) => [r.c, r.ts?.getTime() ?? 0]));

  // Crowd candidates (<= CROWD_MAX per run): researched markets and the top screen priorities first, the rest of the slots rotate through the
  // markets never fetched (then any), pseudo-randomly per 5-minute epoch, so every market is reached over time without a per-market fetch clock.
  // A market outside this run's set keeps its previous crowd fields and last trade; it is only "unknown" if it has never been fetched.
  const thesis = new Set(researched.map((r) => r.c));
  const rank = (m: (typeof mkts)[number]) => (thesis.has(m.conditionId) ? 1e9 : (prev.get(m.conditionId)?.priority ?? -1));
  const ordered = mkts.filter((m) => book.has(m.yesTokenId!)).sort((a, b) => rank(b) - rank(a) || (b.liquidity ?? 0) - (a.liquidity ?? 0));
  const epoch = Math.floor(now / 300_000), fresh = (m: (typeof mkts)[number]) => prev.get(m.conditionId)?.flow24h != null;
  const cand = [...ordered.slice(0, CROWD_TOP), ...ordered.slice(CROWD_TOP).sort((a, b) => +fresh(a) - +fresh(b) || fnv(a.conditionId + epoch) - fnv(b.conditionId + epoch)).slice(0, CROWD_MAX - CROWD_TOP)];
  const candIds = cand.map((m) => m.conditionId);
  const yesOf = new Map(mkts.map((m) => [m.conditionId, m.yesTokenId!]));
  const tokCond = new Map(cand.flatMap((m) => [[m.yesTokenId!, m.conditionId], [m.noTokenId ?? "", m.conditionId]] as const));
  // 24h of trades per market (Data API start/end are ignored, so pm.trades pages by cursor until it passes `since`). Rows come newest first across the whole
  // chunk: a chunk that hits the row cap is re-fetched market by market; a market that still hits it has an incomplete 24h and gets no flow number at all.
  const since = Math.floor((now - 24 * 3_600_000) / 1000);
  const getTrades = async (cs: string[]): Promise<{ rows: Trade[]; cut: string[] }> => {
    const rows = await d.pm.trades({ market: cs, limit: TRADES_CAP, since });
    if (rows.length < TRADES_CAP) return { rows, cut: [] };
    if (cs.length === 1) return { rows, cut: cs };
    const parts = [];
    for (const c of cs) parts.push(await getTrades([c]));
    return { rows: parts.flatMap((p) => p.rows), cut: parts.flatMap((p) => p.cut) };
  };
  const [tradeParts, holderParts] = await Promise.all([
    soft("trades", chunks(candIds, TRADES_CHUNK), getTrades, CROWD_DEADLINE_MS),
    soft("holders", chunks(candIds, 20), (c) => d.pm.holders(c), CROWD_DEADLINE_MS),
  ]);
  const tradeBad = new Set([...tradeParts.failed.flat(), ...tradeParts.ok.flatMap((p) => p.cut)]); // failed chunk, skipped past the deadline, or incomplete 24h

  // trades -> core tradeMetrics (signed 24h flow, median ticket, large-trade flag, last trade) + netFlow in -1..1 for crowding
  const tr = new Map<string, TradeInput[]>(), gross = new Map<string, number>();
  for (const x of tradeParts.ok.flatMap((p) => p.rows)) {
    const c = x.condition_id, yes = c ? yesOf.get(c) : undefined;
    if (!c || !yes) continue;
    (tr.get(c) ?? tr.set(c, []).get(c)!).push({ side: x.side?.toUpperCase() === "SELL" ? "SELL" : "BUY", size: x.size, price: x.price, ts: x.ts * 1000, outcome: x.token_id === yes ? "YES" : "NO" });
    if (x.ts * 1000 > now - 24 * 3_600_000) gross.set(c, (gross.get(c) ?? 0) + x.size * x.price);
  }
  const top10 = new Map<string, number>(), hm = new Map<string, NonNullable<ReturnType<typeof holderMetrics>>>();
  for (const g of holderParts.ok.flat()) {
    const c = tokCond.get(g.token_id);
    if (!c) continue;
    const sum = g.holders.map((h) => h.amount).sort((a, b) => b - a).slice(0, 10).reduce((x, y) => x + y, 0);
    top10.set(c, Math.max(top10.get(c) ?? 0, sum));
    const m = g.token_id === yesOf.get(c) ? holderMetrics(g.holders) : null;
    if (m) hm.set(c, m);
  }

  const hist: (typeof s.snapshots.$inferInsert)[] = [], latest: (typeof ml.$inferInsert)[] = [];
  const isCand = new Set(candIds);
  for (const m of mkts) {
    const b = book.get(m.yesTokenId!);
    const bm = b && bookMetrics(b);
    if (!b || !bm || bm.mid == null) continue;
    const c = m.conditionId, p = prev.get(c), o = oi[c];
    const fetched = isCand.has(c) && !tradeBad.has(c);
    const tm = fetched ? tradeMetrics(tr.get(c) ?? [], now) : null;
    const last = tm?.lastTradeTs ?? (p?.lastTradeTs?.getTime() ?? null); // no trade in the window / not fetched this run: the last one we knew
    const unknown = isCand.has(c) ? !fetched : p?.flow24h == null; // a market outside this run's set is unknown only until it has been fetched once
    const netFlow = tm && gross.get(c) ? tm.flow24h / gross.get(c)! : 0;
    const share = o && top10.has(c) ? Math.min(1, top10.get(c)! / o) : null;
    const h = hm.get(c);
    const midMoved = p?.mid == null || Math.abs(bm.mid - p.mid) >= MID_MOVE - 1e-9;
    // the history row carries more than the book (oi, top-10 share, flow, volume, last trade): a change in any of them (coarsely bucketed) is a change
    const sig = [o != null ? Math.round(Math.log1p(o) / 0.05) : "-", share != null ? Math.round(share * 100) : "-", Math.round(netFlow * 10), +unknown, m.vol24h != null ? Math.round(Math.log1p(m.vol24h) / 0.05) : "-", last ? Math.floor(last / 3_600_000) : "-"].join(",");
    const hash = `${bookHash(b)}.${fnv(sig).toString(16)}`;
    if (!p?.bookHash || hash !== p.bookHash || now - (lastHist.get(c) ?? 0) >= HISTORY_EVERY_MS)
      hist.push({
        conditionId: c, ts: new Date(now), mid: bm.mid, bestBid: bm.bestBid, bestAsk: bm.bestAsk, depth5cUsd: bm.depth5c, vol24h: m.vol24h, oi: o ?? null,
        top10Share: share, lastTradeTs: last ? new Date(last) : null,
        book: {
          bids: b.bids.filter((l) => bm.bestBid == null || l.price >= bm.bestBid - BOOK_WINDOW - 1e-9).slice(0, BOOK_LEVELS),
          asks: b.asks.filter((l) => bm.bestAsk == null || l.price <= bm.bestAsk + BOOK_WINDOW + 1e-9).slice(0, BOOK_LEVELS),
          netFlow, ...(unknown && { flowUnknown: true }),
        },
      });
    latest.push({
      conditionId: c, ts: new Date(now), mid: bm.mid, bestBid: bm.bestBid, bestAsk: bm.bestAsk, spread: bm.spread, depth1c: bm.depth1c, depth2c: bm.depth2c, depth5c: bm.depth5c,
      exitDepth: bm.exitDepth, capacity: bm.capacity, bookHash: hash, midChangedAt: midMoved ? new Date(now) : (p?.midChangedAt ?? new Date(now)),
      holderCount: h?.holderCount ?? null, holderHhi: h?.hhi ?? null, top1Share: h?.top1Share ?? null, top5Share: h?.top5Share ?? null,
      flow24h: tm?.flow24h ?? null, tradeMedian: tm?.tradeMedian ?? null, largeTrade24h: tm ? tm.largeTrade24h : null, lastTradeTs: last ? new Date(last) : null,
    });
  }
  // history first: market_latest.book_hash only advances once the row for that book exists (a failed insert is retried next run)
  for (const c of chunks(hist, 200)) await insertSnapshots(d.db, c);
  for (const c of chunks(latest, 200))
    await d.db.insert(ml).values(c).onConflictDoUpdate({
      target: ml.conditionId,
      set: {
        ts: ex(ml.ts), mid: ex(ml.mid), bestBid: ex(ml.bestBid), bestAsk: ex(ml.bestAsk), spread: ex(ml.spread), depth1c: ex(ml.depth1c), depth2c: ex(ml.depth2c), depth5c: ex(ml.depth5c),
        exitDepth: ex(ml.exitDepth), capacity: ex(ml.capacity), bookHash: ex(ml.bookHash), midChangedAt: ex(ml.midChangedAt),
        holderCount: keep(ml.holderCount), holderHhi: keep(ml.holderHhi), top1Share: keep(ml.top1Share), top5Share: keep(ml.top5Share),
        flow24h: keep(ml.flow24h), tradeMedian: keep(ml.tradeMedian), largeTrade24h: keep(ml.largeTrade24h), lastTradeTs: keep(ml.lastTradeTs),
      },
    });
  // retention rides full sweeps only (ids undefined); a prune failure must not lose the published snapshot result
  if (!ids) try {
    // watched = shortlist (priority>0 or pinned) + live theses + open positions; unwatched markets keep only their latest row
    const [sl, th, pos] = await Promise.all([
      shortlist(d.db, 20),
      d.db.selectDistinct({ c: s.theses.conditionId }).from(s.theses).where(sql`${s.theses.expiresAt} > ${new Date(now)}`),
      d.db.selectDistinct({ c: s.positions.conditionId }).from(s.positions).where(isNull(s.positions.closedAt)),
    ]);
    await pruneSnapshots(d.db, [...new Set([...sl.map((x) => x.conditionId), ...th.map((x) => x.c), ...pos.map((x) => x.c)])], now);
  } catch (e) {
    console.warn("snapshot: prune failed:", String(e).slice(0, 120));
  }
  const out = { markets: mkts.length, snapshots: hist.length, latest: latest.length, unchanged: latest.length - hist.length, noBook: mkts.length - latest.length };
  publish("snapshot.done", out);
  return out;
}

export async function snapshotBooks(d: Deps, scope: "watchlist" | "all") {
  const out = await withLock(d, `snapshot:${scope}`, 4 * 60_000, async () => takeSnapshots(d, scope === "all" ? undefined : await watchlistIds(d)));
  // alerts ride the watchlist cadence; they must never fail (or delay the result of) the snapshot
  if (scope === "watchlist" && !("reason" in out)) await monitor(d).catch((e) => console.warn("monitor failed:", String(e?.message ?? e).slice(0, 160)));
  return out;
}

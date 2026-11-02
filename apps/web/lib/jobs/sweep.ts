import { rulesHash } from "@pm/agents";
import { bookHash, bookMetrics, classifyResolutionSource, holderMetrics, tradeMetrics, type TradeInput } from "@pm/core";
import { insertSnapshots, pruneMarkets, pruneSnapshots, referencedMarkets, schema as s } from "@pm/db";
import type { Market as PmMarket, Trade } from "@pm/pm";
import { KICK_AT } from "../public";
import { chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { monitor } from "./monitor";
import { workingPaperIds, workPaperOrders } from "./paperOrder";
import { heuristicR, preRank, shortlist, watchlistIds, type Listed } from "./screen";

const MAX_FEE_FETCHES = 200;
const WALK_BUDGET_MS = 150_000; // the cron route allows 300 s: walk <= 150 s (+ one page), fees <= FEE_DEADLINE_MS, then closing
const FEE_DEADLINE_MS = 240_000; // from sweep start; remaining fee fetches are skipped (next sweep)
const OPEN = ["active", "disputed", "not_accepting"];

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

type MarketRow = typeof s.markets.$inferSelect;
type MarketIns = typeof s.markets.$inferInsert;
// the columns whose change justifies a write. rules is covered by rules_hash. fee_rate / fee_exponent compare the coalesced value, tick_size too.
const SAME = ["eventId", "question", "category", "tags", "endDate", "negRiskGroup", "status", "pmId", "yesTokenId", "noTokenId", "rulesHash", "heuristicR", "resolutionSource", "negRiskAugmented"] as const;
const KEEP_IF_NULL = ["tickSize", "feeRate", "feeExponent"] as const; // coalesce(excluded, stored): an unknown value keeps the stored one
/** The inserted value as Postgres saw it in `excluded`: column defaults for omitted fields, else null. */
const DEFAULTS: Partial<MarketRow> = { tags: [], status: "active", negRiskAugmented: false };
const excl = <K extends keyof MarketRow>(r: MarketIns, k: K): MarketRow[K] => (r[k as keyof MarketIns] ?? DEFAULTS[k] ?? null) as MarketRow[K];
/** IS NOT DISTINCT FROM: nulls equal, dates by instant, jsonb by value, NaN = NaN (as in Postgres floats). */
const cmp = (v: unknown) => (v instanceof Date ? v.getTime() : v !== null && typeof v === "object" ? JSON.stringify(v) : v);
const same = (a: unknown, b: unknown) => { const x = cmp(a), y = cmp(b); return x === y || (x !== x && y !== y); };
/** liquidity / volume churn every minute: rewrite only when the value moved > 5% (or appeared). */
const moved = (cur: MarketRow, r: MarketIns, k: "liquidity" | "vol24h") => {
  const e = r[k] ?? null, st = cur[k];
  return e !== null && (st === null || Math.abs(e - st) > 0.05 * Math.max(Math.abs(st), 1));
};
const changed = (cur: MarketRow, r: MarketIns) =>
  SAME.some((k) => !same(cur[k], excl(r, k))) || KEEP_IF_NULL.some((k) => !same(cur[k], r[k] ?? cur[k])) || moved(cur, r, "liquidity") || moved(cur, r, "vol24h");
/** The DO UPDATE SET of the old upsert: new values, liquidity / volume only when moved, fee / tick coalesced with the stored value. */
const update = (cur: MarketRow, r: MarketIns): Partial<MarketRow> => ({
  ...Object.fromEntries(SAME.map((k) => [k, excl(r, k)])),
  vol24h: moved(cur, r, "vol24h") ? r.vol24h! : cur.vol24h,
  liquidity: moved(cur, r, "liquidity") ? r.liquidity! : cur.liquidity,
  tickSize: r.tickSize ?? cur.tickSize, feeRate: r.feeRate ?? cur.feeRate, feeExponent: r.feeExponent ?? cur.feeExponent,
});

/** Insert-or-update a page of markets; rows whose meaningful columns are unchanged are not written (not returned either). Returns the written condition ids. */
export async function upsertMarkets(db: Deps["db"], rows: MarketIns[]): Promise<string[]> {
  if (!rows.length) return [];
  const inc = new Map(rows.map((r) => [r.conditionId, r]));
  // read once and write only the changed rows; the write re-checks against the row it patches (compare-and-set), so its decision is the one kept
  const cur = new Map((await db.markets.getMany([...inc.keys()])).map((r) => [r.conditionId, r]));
  const todo = [...inc.values()].filter((r) => { const c = cur.get(r.conditionId); return !c || changed(c, r); });
  if (!todo.length) return [];
  const wrote = new Map<string, boolean>(); // absent = inserted
  await db.markets.upsertMany(todo, (c) => {
    const r = inc.get(c.conditionId)!, w = changed(c, r);
    wrote.set(c.conditionId, w);
    return w ? update(c, r) : null;
  });
  return todo.map((r) => r.conditionId).filter((id) => wrote.get(id) ?? true);
}

/**
 * pm universe -> the markets worth keeping. The listing is ranked in memory on Gamma's own quotes (`preRank`) and only the best slice,
 * plus every market the user's own data references, is upserted; the rest is never stored (Polymarket already serves it) and rows
 * that fall out are pruned with their latest/history/screen rows. Fee rate fetched once per kept market (null = unknown -> category fallback at use).
 */
export async function sweepUniverse(d: Deps) {
  return withLock(d, "sweep", 10 * 60_000, async () => {
    // markets only: each carries its event id and neg-risk group; the events walk is ~1.7 GB of nested markets (OOM on Vercel)
    // and only the screenable slice: ~250k markets are open, ~26k have liquidity >= minLiquidityUsd and resolve within minDays..maxDays (server-side filters)
    const { minDays, maxDays } = d.settings.filters, liquidityMin = d.settings.universe.minLiquidityUsd, now = d.now();
    const endMin = now + minDays * 864e5, endMax = now + maxDays * 864e5;
    const known = new Map((await d.db.markets.all()).map((r) => [r.conditionId, { id: r.conditionId, fee: r.feeRate, status: r.status, end: r.endDate, pmId: r.pmId, rulesHash: r.rulesHash, resolutionSource: r.resolutionSource }]));
    const t0 = Date.now();
    // stream: keep each page's slim row (no rules text) and Gamma touch, never the ~26k full markets (OOM on Vercel)
    const listed = new Map<string, Listed>();
    const { complete, pages } = await d.pm.walkMarkets({ liquidityMin, endDateMin: new Date(endMin).toISOString(), endDateMax: new Date(endMax).toISOString(), budgetMs: WALK_BUDGET_MS }, async (page) => {
      for (const m of page) if (!listed.has(m.condition_id)) listed.set(m.condition_id, { row: toMarketRow(m, known.get(m.condition_id)), bid: m.best_bid ?? null, ask: m.best_ask ?? null });
    });
    const seen = new Set(listed.keys());
    if (!complete) console.warn(`sweep: listing incomplete after ${pages} pages (429/5xx/time budget), ${seen.size} markets listed, closing and pruning skipped`);
    if (!seen.size) return { markets: 0, kept: 0, newMarkets: 0, written: 0, feesFetched: 0, closed: 0, complete };

    const [rr, referenced] = await Promise.all([d.db.rrCache.all(), referencedMarkets(d.db)]);
    const cachedR = new Map(rr.map((x) => [`${x.conditionId}:${x.rulesHash}`, x.r]));
    const kept = preRank([...listed.values()], d.settings, now, cachedR);
    for (const id of referenced) if (listed.has(id)) kept.add(id); // refresh what the user holds or researched while it is listed
    const rows = [...kept].map((id) => listed.get(id)!.row);
    let written = 0;
    for (const c of chunks(rows, 500)) written += (await upsertMarkets(d.db, c)).length;
    const newMarkets = rows.filter((r) => !known.has(r.conditionId)).length;
    const needFee = rows.filter((r) => r.feeRate == null && r.yesTokenId && known.get(r.conditionId)?.fee == null).map((r) => r.conditionId);

    // fees after the upsert (a first run must not block on thousands of fetches); capped per run, the rest next sweep.
    // Gamma's feeSchedule already filled most rows; the rest ask the CLOB market info (its `fd` curve is authoritative, no `fd` = fee-free). /fee-rate is legacy and not used.
    const need = needFee.sort(() => Math.random() - 0.5).slice(0, MAX_FEE_FETCHES); // shuffle: failing markets must not starve the rest
    let feesFetched = 0;
    for (const batch of chunks(need, 20)) {
      if (Date.now() - t0 > FEE_DEADLINE_MS) break;
      const fee = new Map<string, { feeRate: number; feeExponent: number | null }>();
      await Promise.all(batch.map(async (c) => {
        const info = await d.pm.clobMarket(c).catch(() => undefined);
        if (!info) return; // 404 / outage: stays unknown, retried next sweep
        feesFetched++;
        fee.set(c, { feeRate: info.fee_schedule?.rate ?? 0, feeExponent: info.fee_schedule?.exponent ?? null });
      }));
      if (fee.size) await d.db.markets.updateMany([...fee.keys()], (r) => fee.get(r.conditionId) ?? null); // one write per batch
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
    const [heldPos, heldProps, heldPods, heldSets] = await Promise.all([
      d.db.positions.find("open", [{ paper: true }, { paper: false }]),
      d.db.proposals.find("status", [{ status: "pending" }, { status: "approved" }]),
      d.db.pods.find("byStarted", {}, { min: new Date(now - 30 * 864e5) }), // researched (e.g. searched-and-ingested) markets stay open too
      d.db.proposalSets.find("status", ["pending", "sending", "unwinding", "flagged"].map((status) => ({ status }))),
    ]);
    const held = new Set([
      ...heldPos.map((r) => r.conditionId), ...heldProps.map((r) => r.conditionId), ...heldPods.map((r) => r.conditionId),
      ...heldSets.flatMap((r) => r.legs.map((l) => l.conditionId)),
    ]);
    const missing = truncated ? [] : knownOpen.filter(([id]) => !seen.has(id));
    const stillOpen = new Set((await Promise.all(missing.filter(([id]) => held.has(id)).map(async ([id, r]) => ((await d.pm.market(r.pmId ?? id).catch(() => undefined))?.open !== false ? id : null)))).flatMap((id) => id ?? []));
    const gone = missing.map(([id]) => id).filter((id) => !stillOpen.has(id));
    if (gone.length) await d.db.markets.updateMany(gone, { status: "closed" });
    // a truncated listing would drop live markets that simply were not walked: prune only after a full one
    if (!truncated) await pruneMarkets(d.db, [...new Set([...kept, ...referenced, ...held])]);

    const out = { markets: seen.size, kept: kept.size, newMarkets, written, feesFetched, closed: gone.length, complete };
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
type LatestRow = typeof ml.$inferSelect;
/** market_latest columns the snapshot job owns: book columns take the new value; crowd columns keep the stored one when the new is null. */
const BOOK_COLS = ["ts", "mid", "bestBid", "bestAsk", "spread", "depth1c", "depth2c", "depth5c", "exitDepth", "capacity", "bookHash", "midChangedAt"] as const;
const CROWD_COLS = ["holderCount", "holderHhi", "top1Share", "top5Share", "flow24h", "tradeMedian", "largeTrade24h", "lastTradeTs"] as const;

/**
 * Snapshot `ids` (default: every open market). market_latest is upserted in place every run; a history row (`snapshots`) is appended
 * only when the book changed or the last one is older than an hour. Not locked: callers lock.
 */
export async function takeSnapshots(d: Deps, ids?: string[]) {
  const t0 = Date.now();
  const mkts = (ids ? await d.db.markets.getMany([...new Set(ids)]) : await d.db.markets.find("status", OPEN.map((status) => ({ status }))))
    .filter((m) => OPEN.includes(m.status) && m.yesTokenId !== null);
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
  const [books, oiParts, prevRows, recentRows, researched] = await Promise.all([
    d.pm.books(mkts.map((m) => m.yesTokenId!)),
    soft("oi", chunks(conds, OI_CHUNK), (c) => d.pm.oi(c)),
    d.db.marketLatest.getMany(conds),
    // "now - max(ts) >= HISTORY_EVERY_MS" is "no history row newer than now - HISTORY_EVERY_MS": ids only, at most one per market
    d.db.snapshots.idsEach("cond", conds.map((conditionId) => ({ conditionId })), { gt: now - HISTORY_EVERY_MS, limit: 1 }),
    d.db.theses.distinct("cond"),
  ]);
  const book = new Map(books.map((b) => [b.token_id, b]));
  const oi: Record<string, number> = Object.assign({}, ...oiParts.ok);
  const prev = new Map(prevRows.map((r) => [r.conditionId, r])), recentHist = new Set(conds.filter((_, i) => recentRows[i]!.length > 0));

  // Crowd candidates (<= CROWD_MAX per run): researched markets and the top screen priorities first, the rest of the slots rotate through the
  // markets never fetched (then any), pseudo-randomly per 5-minute epoch, so every market is reached over time without a per-market fetch clock.
  // A market outside this run's set keeps its previous crowd fields and last trade; it is only "unknown" if it has never been fetched.
  const thesis = new Set(researched);
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
    if (!p?.bookHash || hash !== p.bookHash || !recentHist.has(c))
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
  // patched onto the current row (never priority / structural / opportunity: the screen owns those), atomic per ~200-row chunk
  const byCond = new Map(latest.map((r) => [r.conditionId, r]));
  await d.db.marketLatest.upsertMany(latest, (cur) => {
    const r = byCond.get(cur.conditionId)! as Partial<LatestRow>;
    return Object.fromEntries([...BOOK_COLS.map((k) => [k, r[k] ?? null]), ...CROWD_COLS.map((k) => [k, r[k] ?? cur[k]])]) as Partial<LatestRow>;
  });
  // retention rides full sweeps only (ids undefined); a prune failure must not lose the published snapshot result
  if (!ids) try {
    // watched = shortlist (priority>0 or pinned) + live theses + open positions; unwatched markets keep only their latest row
    const [sl, th, pos] = await Promise.all([
      shortlist(d.db, 20),
      d.db.theses.find("byExpiry", {}, { gt: new Date(now) }), // expiresAt > now (no-expiry theses excluded, as before)
      d.db.positions.find("open", [{ paper: true }, { paper: false }]),
    ]);
    await pruneSnapshots(d.db, [...new Set([...sl.map((x) => x.conditionId), ...th.map((x) => x.conditionId), ...pos.map((x) => x.conditionId)])], now);
  } catch (e) {
    console.warn("snapshot: prune failed:", String(e).slice(0, 120));
  }
  const out = { markets: mkts.length, snapshots: hist.length, latest: latest.length, unchanged: latest.length - hist.length, noBook: mkts.length - latest.length };
  publish("snapshot.done", out);
  return out;
}

export async function snapshotBooks(d: Deps, scope: "watchlist" | "all") {
  const ids = async () => { const w = await watchlistIds(d); return w && [...new Set([...w, ...await workingPaperIds(d)])]; }; // undefined (no screen yet) = all
  const out = await withLock(d, `snapshot:${scope}`, 4 * 60_000, async () => takeSnapshots(d, scope === "all" ? undefined : await ids()));
  // resting paper limits and stops ride every snapshot: the books are fresh now
  if (!("reason" in out)) await withLock(d, "paperwork", 60_000, () => workPaperOrders(d)).catch((e) => console.warn("paper orders failed:", String(e?.message ?? e).slice(0, 160)));
  // alerts ride the watchlist cadence; they must never fail (or delay the result of) the snapshot
  if (scope === "watchlist" && !("reason" in out)) await monitor(d).catch((e) => console.warn("monitor failed:", String(e?.message ?? e).slice(0, 160)));
  return out;
}

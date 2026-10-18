import { depthWithin, midOf } from "@pm/core";
import { insertSnapshots, schema as s } from "@pm/db";
import type { Market as PmMarket } from "@pm/pm";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { KICK_AT } from "../public";
import { chunks, withLock, type Deps } from "./deps";
import { publish } from "./events";
import { watchlistIds } from "./screen";

const MAX_FEE_FETCHES = 200;
const OPEN = ["active", "disputed", "not_accepting"];
const ex = (c: { name: string }) => sql.raw(`excluded."${c.name}"`);

const statusOf = (m: PmMarket) => (!m.open ? "closed" : m.in_dispute ? "disputed" : !m.accepting_orders ? "not_accepting" : "active");

/** pm universe (markets + events) -> `markets` upsert. Fee rate fetched once per new market (null = unknown -> category fallback at use). */
export async function sweepUniverse(d: Deps) {
  return withLock(d, "sweep", 10 * 60_000, async () => {
    // markets only: each carries its event id and neg-risk group; the events walk is ~1.7 GB of nested markets (OOM on Vercel)
    // and only the screenable slice: ~250k markets are open, ~26k have liquidity >= minLiquidityUsd and resolve within minDays..maxDays (server-side filters)
    const { minDays, maxDays } = d.settings.filters, liquidityMin = d.settings.universe.minLiquidityUsd, now = d.now();
    const endMin = now + minDays * 864e5, endMax = now + maxDays * 864e5;
    const byCond = new Map<string, PmMarket>((await d.pm.listMarkets({ liquidityMin, endDateMin: new Date(endMin).toISOString(), endDateMax: new Date(endMax).toISOString() })).map((m) => [m.condition_id, m]));
    if (!byCond.size) return { markets: 0, newMarkets: 0, feesFetched: 0, closed: 0 };

    const known = new Map((await d.db.select({ id: s.markets.conditionId, fee: s.markets.feeRate, status: s.markets.status, end: s.markets.endDate, pmId: s.markets.pmId }).from(s.markets)).map((r) => [r.id, r]));
    const rows = [...byCond.values()].map((m): typeof s.markets.$inferInsert => ({
      conditionId: m.condition_id,
      eventId: m.event_id ?? null,
      question: m.question,
      rules: m.rules ?? "",
      category: m.category ?? null,
      tags: m.tags,
      endDate: m.end_date ? new Date(m.end_date) : null,
      negRiskGroup: m.neg_risk ? (m.neg_risk_group ?? null) : null,
      feeRate: null, // filled below; upsert keeps the stored rate
      status: statusOf(m),
      pmId: m.id,
      yesTokenId: m.yes_token_id ?? null,
      noTokenId: m.no_token_id ?? null,
      vol24h: m.volume_24h ?? null,
    }));
    const t = s.markets;
    for (const c of chunks(rows, 500))
      await d.db.insert(t).values(c).onConflictDoUpdate({
        target: t.conditionId,
        set: {
          eventId: ex(t.eventId), question: ex(t.question), rules: ex(t.rules), category: ex(t.category), tags: ex(t.tags),
          endDate: ex(t.endDate), negRiskGroup: ex(t.negRiskGroup), status: ex(t.status), pmId: ex(t.pmId),
          yesTokenId: ex(t.yesTokenId), noTokenId: ex(t.noTokenId), vol24h: ex(t.vol24h),
          feeRate: sql`coalesce(excluded."fee_rate", ${t.feeRate})`,
        },
      });

    // fees after the upsert (a first run must not block on thousands of fetches); capped per run, the rest next sweep
    const need = [...byCond.values()].filter((m) => m.yes_token_id && known.get(m.condition_id)?.fee == null).sort(() => Math.random() - 0.5).slice(0, MAX_FEE_FETCHES); // shuffle: failing markets must not starve the rest
    let feesFetched = 0;
    for (const batch of chunks(need, 20))
      await Promise.all(batch.map(async (m) => {
        const bps = await d.pm.feeRateBps(m.yes_token_id!).catch(() => undefined);
        if (bps === undefined) return;
        feesFetched++; // unit unverified (see TASKS T4)
        await d.db.update(t).set({ feeRate: bps / 10_000 }).where(eq(t.conditionId, m.condition_id));
      }));

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
    const shrunk = prev != null && byCond.size < 0.9 * prev;
    const streak = shrunk ? ((await d.kv.get<number>(shrinkKey)) ?? 0) + 1 : 0;
    const truncated = shrunk && streak < 3;
    if (truncated) console.warn(`sweep: listing truncated (${byCond.size} vs previous ${prev}, ${streak}/3), skipping close`);
    await d.kv.set(shrinkKey, truncated ? streak : 0);
    if (!truncated) await d.kv.set(listingKey, byCond.size);
    // a market we hold, or one in a pending proposal / unsettled set, closes only when Gamma says it is closed (resolution still needs the flip);
    // merely falling out of the filter, or a failed lookup, keeps it open so snapshots and exits keep running
    const held = new Set([
      ...(await d.db.select({ c: s.positions.conditionId }).from(s.positions).where(isNull(s.positions.closedAt))).map((r) => r.c),
      ...(await d.db.select({ c: s.proposals.conditionId }).from(s.proposals).where(inArray(s.proposals.status, ["pending", "approved"]))).map((r) => r.c),
      ...(await d.db.select({ l: s.proposalSets.legs }).from(s.proposalSets).where(inArray(s.proposalSets.status, ["pending", "sending", "unwinding", "flagged"]))).flatMap((r) => r.l.map((l) => l.conditionId)),
    ]);
    const missing = truncated ? [] : knownOpen.filter(([id]) => !byCond.has(id));
    const stillOpen = new Set((await Promise.all(missing.filter(([id]) => held.has(id)).map(async ([id, r]) => ((await d.pm.market(r.pmId ?? id).catch(() => undefined))?.open !== false ? id : null)))).flatMap((id) => id ?? []));
    const gone = missing.map(([id]) => id).filter((id) => !stillOpen.has(id));
    for (const c of chunks(gone, 500)) await d.db.update(t).set({ status: "closed" }).where(inArray(t.conditionId, c));

    const out = { markets: rows.length, newMarkets: rows.filter((r) => !known.has(r.conditionId)).length, feesFetched, closed: gone.length };
    await d.kv.set(KICK_AT, Date.now()); // public sweptAt/stale detection, also covers cron sweeps
    publish("sweep.done", out);
    return out;
  });
}

const BOOK_LEVELS = 40; // ponytail: per side, bounds snapshot row size; sizing never walks deeper than this in practice

/** Append snapshots for `ids` (default: every open market). Not locked: callers lock. */
export async function takeSnapshots(d: Deps, ids?: string[]) {
  const t = s.markets;
  const mkts = await d.db.select().from(t).where(and(inArray(t.status, OPEN), isNotNull(t.yesTokenId), ids ? inArray(t.conditionId, ids) : undefined));
  if (!mkts.length) return { markets: 0, snapshots: 0, noBook: 0 };
  const conds = mkts.map((m) => m.conditionId);
  const now = d.now();

  // OI and trades are enrichment: a failing chunk (e.g. the data API's Cloudflare 403) leaves those markets without oi/flow, books still land.
  const soft = async <T>(what: string, jobs: Promise<T>[]) => {
    const rs = await Promise.allSettled(jobs);
    const bad = rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (bad.length) console.warn(`snapshot: ${what} failed for ${bad.length}/${rs.length} chunks: ${String(bad[0]!.reason).slice(0, 120)}`);
    return rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  };
  const [books, oiParts, tradeParts] = await Promise.all([
    d.pm.books(mkts.map((m) => m.yesTokenId!)),
    soft("oi", chunks(conds, 50).map((c) => d.pm.oi(c))),
    soft("trades", chunks(conds, 25).map((c) => d.pm.trades({ market: c, limit: 500 }))),
  ]);
  const book = new Map(books.map((b) => [b.token_id, b]));
  const oi: Record<string, number> = Object.assign({}, ...oiParts);

  // trades -> last trade ts + signed 24h flow on the YES token (buy YES / sell NO = +)
  const yesOf = new Map(mkts.map((m) => [m.conditionId, m.yesTokenId]));
  const flow = new Map<string, { last: number; net: number; gross: number }>();
  for (const tr of tradeParts.flat()) {
    const c = tr.condition_id;
    if (!c || !yesOf.has(c)) continue;
    const f = flow.get(c) ?? { last: 0, net: 0, gross: 0 };
    f.last = Math.max(f.last, tr.ts * 1000);
    if (tr.ts * 1000 > now - 24 * 3_600_000) {
      const usd = tr.size * tr.price, sign = (tr.side?.toUpperCase() === "SELL" ? -1 : 1) * (tr.token_id === yesOf.get(c) ? 1 : -1);
      f.net += sign * usd;
      f.gross += usd;
    }
    flow.set(c, f);
  }

  // crowding input only for researched markets (holders endpoint is 1000 req/10s, SPEC cadence 15 min)
  const researched = new Set((await d.db.selectDistinct({ c: s.theses.conditionId }).from(s.theses)).map((r) => r.c));
  const hold = conds.filter((c) => researched.has(c));
  const tokCond = new Map(mkts.flatMap((m) => [[m.yesTokenId!, m.conditionId], [m.noTokenId ?? "", m.conditionId]] as const));
  const top10 = new Map<string, number>();
  for (const g of (await Promise.all(chunks(hold, 20).map((c) => d.pm.holders(c)))).flat()) {
    const c = tokCond.get(g.token_id);
    if (!c) continue;
    const sum = g.holders.map((h) => h.amount).sort((a, b) => b - a).slice(0, 10).reduce((x, y) => x + y, 0);
    top10.set(c, Math.max(top10.get(c) ?? 0, sum));
  }

  const rows: (typeof s.snapshots.$inferInsert)[] = [];
  for (const m of mkts) {
    const b = book.get(m.yesTokenId!);
    const mid = b ? midOf(b.bids, b.asks) : null;
    if (!b || mid == null) continue;
    const f = flow.get(m.conditionId);
    const o = oi[m.conditionId];
    rows.push({
      conditionId: m.conditionId,
      ts: new Date(now),
      mid,
      bestBid: Math.max(...b.bids.map((l) => l.price)),
      bestAsk: Math.min(...b.asks.map((l) => l.price)),
      depth5cUsd: depthWithin(b.bids, mid, 5) + depthWithin(b.asks, mid, 5),
      vol24h: m.vol24h,
      oi: o ?? null,
      top10Share: o && top10.has(m.conditionId) ? Math.min(1, top10.get(m.conditionId)! / o) : null,
      lastTradeTs: f?.last ? new Date(f.last) : null,
      book: { bids: b.bids.slice(0, BOOK_LEVELS), asks: b.asks.slice(0, BOOK_LEVELS), netFlow: f?.gross ? f.net / f.gross : 0 },
    });
  }
  for (const c of chunks(rows, 200)) await insertSnapshots(d.db, c);
  const out = { markets: mkts.length, snapshots: rows.length, noBook: mkts.length - rows.length };
  publish("snapshot.done", out);
  return out;
}

export const snapshotBooks = (d: Deps, scope: "watchlist" | "all") =>
  withLock(d, `snapshot:${scope}`, 4 * 60_000, async () => takeSnapshots(d, scope === "all" ? undefined : await watchlistIds(d)));

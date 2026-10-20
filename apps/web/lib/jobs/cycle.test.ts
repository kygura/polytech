import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, type Book } from "@pm/pm";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { calibrateNightly, deps, monitor, read, researchShortlist, screenAll, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

// SPEC Rev 7 "Done": with PM_FIXTURES and no API keys a sweep -> snapshot -> screen -> monitor cycle fills market_latest and alerts.
// Fixtures: 39 open markets, a neg-risk ladder that is a structural arb, holders/trades for a subset.
const fx = createPm({ fixtures: true });
let T = Date.parse("2026-10-15T12:00:00Z");
const shift = new Map<string, number>(); // token -> price shift (the market "moves")
const pm = { ...fx, books: async (tokens: string[]) => (await fx.books(tokens)).map((b): Book => { const x = shift.get(b.token_id); return x ? { ...b, bids: b.bids.map((l) => ({ ...l, price: l.price + x })), asks: b.asks.map((l) => ({ ...l, price: l.price + x })) } : b; }) } as typeof fx;
let d: Deps;
const events: string[] = [];
const run = <K>(f: (dd: Deps) => Promise<K>) => f({ ...d, now: () => (T += 1000) });

beforeAll(async () => {
  d = await deps({ pm, kv: memoryKv(), now: () => T, runner: fakeRunner, judge: fakeJudge });
  subscribe((e) => events.push(e.type));
}, 60_000);

describe("sweep -> snapshot -> screen -> monitor (fixtures, no API keys)", () => {
  it("fills markets, market_latest with book + crowd + screen output, and raises the first alerts", async () => {
    await run(sweepUniverse);
    await run((dd) => snapshotBooks(dd, "all"));
    await run(screenAll);
    const ml = await d.db.select().from(s.marketLatest);
    expect(ml.length).toBeGreaterThan(30);
    expect(ml.filter((r) => (r.priority ?? 0) > 0).length).toBeGreaterThan(5);
    expect(ml.filter((r) => r.structural?.length).length).toBeGreaterThan(0); // the Fed / ceasefire neg-risk baskets and the Bitcoin ladder
    expect(ml.some((r) => r.structural?.includes("overround"))).toBe(true);
    expect(ml.filter((r) => r.holderCount != null).length).toBeGreaterThan(0);
    const out = await run(monitor);
    expect(out).toMatchObject({ raised: expect.any(Number) });
    expect((out as { raised: number }).raised).toBeGreaterThanOrEqual(1);
    const al = await d.db.select().from(s.alerts);
    expect(al.length).toBeGreaterThanOrEqual(1);
    expect(new Set(al.map((a) => a.kind))).toContain("structural");
    expect(events).toContain("alert.created");
    if ((out as { suppressed: number }).suppressed) await run(monitor); // the cap left some for the next pass
    expect(await run(monitor)).toMatchObject({ raised: 0 }); // then nothing is new: state + cooldown
  });

  it("a thesis on a market that then moves raises mid_move, and the screen writes its sized opportunity", async () => {
    const res = await run((dd) => researchShortlist(dd, { limit: 3 }));
    expect((res as { theses: string[] }).theses.length).toBeGreaterThan(0);
    await run(screenAll);
    const th = await d.db.select().from(s.theses);
    const opp = await d.db.select().from(s.marketLatest).where(inArray(s.marketLatest.conditionId, th.map((t) => t.conditionId)));
    expect(opp.some((r) => r.opportunity && r.opportunity.stake > 0 && Number.isFinite(r.opportunity.edge) && r.opportunity.o >= 0)).toBe(true);
    // the market moves 8c against the thesis mid
    const t0 = th[0]!, m = (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, t0.conditionId)))[0]!;
    const at = (t0.detail as { pMidYes: number }).pMidYes;
    shift.set(m.yesTokenId!, at > 0.5 ? -0.08 : 0.08);
    await run((dd) => snapshotBooks(dd, "watchlist")); // monitor rides its tail
    const moved = (await d.db.select().from(s.alerts)).filter((a) => a.kind === "mid_move");
    expect(moved.map((a) => a.conditionId)).toContain(t0.conditionId);
  });

  it("calibrate builds the journal rows for those theses", async () => {
    const out = (await run(calibrateNightly)) as { journal: { theses: number; upserted: number } };
    expect(out.journal.theses).toBeGreaterThan(0);
    const rows = await d.db.select().from(s.journal);
    expect(rows.length).toBe(out.journal.theses);
    expect(rows.every((j) => j.pHat != null && j.model && j.side)).toBe(true);
  });

  it("the structural watchlist read is cached for a few seconds and cleared by the next screen", async () => {
    const r = { db: d.db, now: d.now };
    const a = await read.watchlist(r, "structural"), b = await read.watchlist(r, "structural");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a); // same in-flight/cached result object
    await run(screenAll);
    expect(await read.watchlist(r, "structural")).not.toBe(a);
  });
});

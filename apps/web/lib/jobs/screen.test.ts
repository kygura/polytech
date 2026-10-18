import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deps, screenAll, snapshotBooks, sweepUniverse, type Deps } from "./index";
import { detectStructural, heuristicR, smallCapTooBusy } from "./screen";

process.env.PGLITE_DIR = "memory://";

type Rows = Parameters<typeof detectStructural>[0];
const row = (id: string, o: { q?: string; end?: number; group?: string; bid: number; ask: number }) => ({
  m: { conditionId: id, eventId: id, question: o.q ?? `Will ${id} happen`, rules: "", category: "other", tags: [], endDate: o.end ?? Date.parse("2027-01-01"), negRiskGroup: o.group ?? null, feeRate: 0 },
  snap: { mid: (o.bid + o.ask) / 2, book: { bids: [{ price: o.bid, size: 1000 }], asks: [{ price: o.ask, size: 1000 }] } },
}) as unknown as Rows[number];

describe("detectStructural", () => {
  const negs = [row("a", { group: "g", bid: 0.25, ask: 0.3 }), row("b", { group: "g", bid: 0.25, ask: 0.3 })];
  it("neg-risk buy-all needs every leg of the group present", () => {
    expect(detectStructural(negs, 50, new Map([["g", 3]])).size).toBe(0);
    expect(detectStructural(negs, 50, new Map([["g", 2]])).get("a")).toMatchObject({ kind: "buy-all" });
  });
  const ladder = (earlyBid: number, earlyAsk: number, lateBid: number, lateAsk: number) => [
    row("e", { q: "Will X happen by June 1", end: Date.parse("2027-06-01"), bid: earlyBid, ask: earlyAsk }),
    row("l", { q: "Will X happen by July 1", end: Date.parse("2027-07-01"), bid: lateBid, ask: lateAsk }),
  ];
  it("ladder claimed only with positive locked edge", () => {
    expect(detectStructural(ladder(0.58, 0.62, 0.48, 0.52), 50).get("e")?.lockedC).toBeGreaterThan(0);
    expect(detectStructural(ladder(0.5, 0.7, 0.3, 0.7), 50).size).toBe(0); // bid 0.50 < ask 0.70
  });
  it("mirror needs same end date", () => {
    const mk = (end2: number) => [
      row("m1", { q: "Will Federal Data Privacy Act pass", bid: 0.6, ask: 0.62 }),
      row("m2", { q: "Will Federal Data Privacy Act pass", end: end2, bid: 0.4, ask: 0.42 }),
    ];
    expect(detectStructural(mk(Date.parse("2027-01-01")), 50).get("m1")).toMatchObject({ type: "mirror" });
    expect(detectStructural(mk(Date.parse("2028-01-01")), 50).size).toBe(0);
  });
});

describe("smallCapTooBusy", () => {
  const st = { universe: { minLiquidityUsd: 1000, smallCapMaxVol24hUsd: 50_000 } };
  it("drops busy small-caps; size tier, structural legs and quiet markets stay", () => {
    expect(smallCapTooBusy("small-cap", 60_000, false, st)).toBe(true);
    expect(smallCapTooBusy("small-cap", 50_000, false, st)).toBe(false);
    expect(smallCapTooBusy("size", 60_000, false, st)).toBe(false);
    expect(smallCapTooBusy("small-cap", 60_000, true, st)).toBe(false);
  });
});

describe("screenAll LLM budget", () => {
  let d: Deps;
  beforeAll(async () => {
    let t = Date.parse("2026-10-15T12:00:00Z");
    d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge });
    await sweepUniverse(d);
    await snapshotBooks(d, "all");
  }, 60_000);
  const reset = async () => { await d.db.delete(s.rrCache); await d.db.delete(s.screens); };
  const withR = (rScore: Deps["rScore"], over: Partial<Deps> = {}) => ({ ...d, rScore, ...over });

  it("budget exhausted: screens row still written, unattempted markets take the heuristic", async () => {
    await reset();
    const rules = new Map((await d.db.select().from(s.markets)).map((m) => [m.conditionId, m.rules ?? ""]));
    let skew = 0;
    const real = Date.now, spy = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    await screenAll(withR(async () => ((skew += 1_000), 1)), { budgetMs: 5_000 }).finally(() => spy.mockRestore()); // each LLM call "takes" 1s: 5 calls blow the budget
    const screens = await d.db.select().from(s.screens);
    const cached = await d.db.select().from(s.rrCache);
    expect(screens.length).toBeGreaterThan(cached.length);
    expect(cached.length).toBe(10); // exactly one batch ran
    const done = new Set(cached.map((c) => c.conditionId));
    const rest = screens.filter((x) => !done.has(x.conditionId));
    expect(rest.every((x) => x.r === heuristicR(rules.get(x.conditionId)!))).toBe(true);
  });

  it("caps LLM calls per run", async () => {
    await reset();
    let n = 0;
    await screenAll(withR(async () => (n++, 0.5)), { maxLlm: 7 });
    expect(n).toBe(7);
    expect((await d.db.select().from(s.screens)).length).toBeGreaterThan(7);
  });

  it("sends highest-priority candidates first and records spend", async () => {
    await reset();
    const order: string[] = [];
    await screenAll(withR(async (r) => (order.push(r), heuristicR(r))), { maxLlm: 12 });
    const byRules = new Map((await d.db.select().from(s.markets)).map((m) => [m.rules ?? "", m.conditionId]));
    const pri = new Map((await d.db.select().from(s.screens)).map((x) => [x.conditionId, x.priority ?? 0]));
    const sent = new Set(order.map((r) => byRules.get(r)!));
    const ps = (sentSide: boolean) => [...pri].filter(([c, p]) => p > 0 && sent.has(c) === sentSide).map(([, p]) => p);
    expect(order.length).toBe(12);
    expect(Math.min(...ps(true))).toBeGreaterThanOrEqual(Math.max(...ps(false)));
    const [sp] = await d.db.select().from(s.spend);
    expect(sp!.anthropicUsd).toBeGreaterThan(0);
  });

  it("persists rr_cache per batch: a failure on batch 3 keeps batches 1-3 cached", async () => {
    await reset();
    let spends = 0;
    const db = new Proxy(d.db, { get: (o, k) => k === "insert" ? (tbl: unknown) => { if (tbl === s.spend && ++spends === 3) throw new Error("boom"); return o.insert(tbl as never); } : Reflect.get(o, k).bind?.(o) ?? Reflect.get(o, k) });
    await expect(screenAll(withR(async () => 0.5, { db }), { maxLlm: 100 })).rejects.toThrow("boom");
    expect((await d.db.select().from(s.rrCache)).length).toBeGreaterThanOrEqual(20);
  });

  it("a stalled rScore times out to the heuristic and the run still writes screens", async () => {
    await reset();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const run = screenAll(withR(() => new Promise<number>(() => {}), {}), { maxLlm: 10 });
      await vi.advanceTimersByTimeAsync(25_000);
      await run;
    } finally { vi.useRealTimers(); }
    expect((await d.db.select().from(s.screens)).length).toBeGreaterThan(0);
    expect((await d.db.select().from(s.rrCache)).every((c) => (c.detail as { fallback: boolean }).fallback)).toBe(true);
  }, 30_000);

  it("screens insert is all-or-nothing", async () => {
    await reset();
    const db = new Proxy(d.db, { get: (o, k) => k === "transaction" ? (cb: (tx: unknown) => Promise<unknown>) => o.transaction((tx) => cb(new Proxy(tx, { get: (x, m) => m === "insert" ? (tbl: unknown) => { const q = x.insert(tbl as never); return tbl === s.screens ? { values: async (v: never) => { await q.values(v); throw new Error("boom"); } } : q; } : Reflect.get(x, m).bind?.(x) ?? Reflect.get(x, m) }))) : Reflect.get(o, k).bind?.(o) ?? Reflect.get(o, k) });
    await expect(screenAll({ ...d, db } as Deps)).rejects.toThrow("boom");
    expect(await d.db.select().from(s.screens)).toHaveLength(0);
  });

  it("daily spend cap hit: zero LLM calls", async () => {
    await reset();
    await d.db.insert(s.spend).values({ day: new Date(d.now()).toISOString().slice(0, 10), anthropicUsd: d.settings.budget.dailySpendCapUsd, sandboxS: 0 }).onConflictDoUpdate({ target: s.spend.day, set: { anthropicUsd: d.settings.budget.dailySpendCapUsd } });
    let n = 0;
    await screenAll(withR(async () => (n++, 0.5)));
    expect(n).toBe(0);
    expect((await d.db.select().from(s.screens)).length).toBeGreaterThan(0);
  });
});

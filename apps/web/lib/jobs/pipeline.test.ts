import { AnthropicOutageError, disabledRunner, fakeJudge, fakeRunner, type AgentRunner } from "@pm/agents";
import { DEFAULT_SETTINGS } from "@pm/core";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { calibrateNightly, deps, kill, paperBook, read, researchMarket, researchShortlist, screenAll, setMode, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";
const cid = (k: string) => "0x" + createHash("sha256").update("cond:" + k).digest("hex"); // gen-fixtures.ts
const ids = (ks: string[]) => ks.map(cid);

let t = Date.parse("2026-10-15T12:00:00Z");
const pm = createPm({ fixtures: true });
let d: Deps, r: Pick<Deps, "db" | "now">;
const events: string[] = [];

beforeAll(async () => {
  d = await deps({ pm, kv: memoryKv(), now: () => (t += 1), runner: fakeRunner, judge: fakeJudge });
  r = { db: d.db, now: d.now };
  subscribe((e) => events.push(e.type));
  await sweepUniverse(d);
  await snapshotBooks(d, "all");
  await screenAll(d);
  await researchShortlist(d, { limit: 12 });
  await setMode(d, "L1", "test");
  await paperBook(d);
}, 60_000);

describe("pipeline (fixtures + fake runner/judge)", () => {
  it("sweep maps pm -> markets", async () => {
    const rows = await d.db.select().from(s.markets);
    expect(rows).toHaveLength(39); // 40 fixtures minus the closed x1
    const a1 = rows.find((m) => m.conditionId === cid("a1"))!;
    expect(a1.feeRate).toBeCloseTo(0.04); // 400 bps
    expect(a1.negRiskGroup).toBeTruthy();
    expect(rows.find((m) => m.conditionId === cid("d1"))!.status).toBe("disputed");
    expect(rows.find((m) => m.conditionId === cid("n1"))!.status).toBe("not_accepting");
    expect(rows.find((m) => m.conditionId === cid("s1"))!.feeRate).toBe(0); // geopolitics 0 bps is a real 0, not "unknown"
  });

  it("watchlist is populated in both tiers; illiquid and disputed are filtered", async () => {
    const small = await read.watchlist(r, "small-cap"), size = await read.watchlist(r, "size");
    expect(small.length).toBeGreaterThan(0);
    expect(size.length).toBeGreaterThan(0);
    const all = new Set([...small, ...size].map((x) => x.conditionId));
    for (const k of ["i1", "i2", "i3", "i4", "d1", "n1"]) expect(all.has(cid(k))).toBe(false);
    expect([...small, ...size].some((x) => x.thesisId)).toBe(true);
  });

  it("structural tab holds the neg-risk arb, ladder and mirror", async () => {
    const st = await read.watchlist(r, "structural");
    const by = new Map(st.map((x) => [x.conditionId, x]));
    for (const k of ["a1", "a2", "a3", "a4"]) {
      expect(by.get(cid(k))).toMatchObject({ type: "neg-risk-sum", kind: "buy-all", legs: 4 });
      expect(by.get(cid(k))!.lockedC).toBeGreaterThan(5);
    }
    for (const k of ["c1", "c2", "c3"]) expect(by.get(cid(k))).toMatchObject({ type: "neg-risk-sum", kind: "sell-all" });
    for (const k of ["l2", "l3"]) expect(by.get(cid(k))!.type).toBe("ladder");
    for (const k of ["m1", "m2"]) expect(by.get(cid(k))!.type).toBe("mirror");
    for (const k of ["b1", "b2", "b3", "l1", "p1", "i1", "d1"]) expect(by.has(cid(k))).toBe(false);
    expect(st.every((x) => x.sizeUsd <= 0.05 * DEFAULT_SETTINGS.bankroll + 1e-9)).toBe(true);
  });

  it("theses respect the 5% cap and carry the full sizing row", async () => {
    const th = await d.db.select().from(s.theses);
    expect(th.length).toBeGreaterThan(0);
    for (const x of th) {
      expect(x.sizeUsd).toBeLessThanOrEqual(0.05 * DEFAULT_SETTINGS.bankroll + 1e-9);
      expect(x.c).toBeLessThanOrEqual(0.4 + 1e-9); // < 30 resolved
    }
    const ev = await d.db.select().from(s.evidence);
    expect(ev.length).toBeGreaterThan(0);
    const spend = await d.db.select().from(s.spend);
    expect(spend).toHaveLength(1);
    const tid = th[0]!.conditionId;
    const det = await read.marketDetail(r, tid);
    expect(det!.thesis!.thesis).toMatch(/Fake judge/);
    expect(det!.agents).toHaveLength(6); // 5 roles + judge
    expect(det!.evidence.length).toBeGreaterThan(0);
  });

  it("L2 request is refused with EXECUTION_DISABLED and the mode stays", async () => {
    const res = await setMode(d, "L2", "try");
    expect(res).toMatchObject({ allowed: false, mode: "L1", reason: "EXECUTION_DISABLED" });
    const a = await read.autonomy(r);
    expect(a.mode).toBe("L1");
    expect(a.events[0]).toMatchObject({ reason: "EXECUTION_DISABLED", fromMode: "L1", toMode: "L1" });
  });

  it("paper fills exist and a re-run does not double-fill", async () => {
    const book = await read.paperBook(r);
    expect(book.summary.open).toBeGreaterThan(0);
    expect(book.fills.length).toBe(book.summary.open);
    expect(book.fills[0]!.modeledK).toBeGreaterThan(0);
    const f0 = book.fills[0]!;
    expect(f0.slipC).toBeCloseTo((f0.price + f0.fee / f0.size - f0.modeledK!) * 100, 9); // fee-inclusive fill vs k
    const before = (await d.db.select().from(s.orders)).length;
    const again = await paperBook(d);
    expect(again).toMatchObject({ filled: 0 });
    expect((await d.db.select().from(s.orders)).length).toBe(before);
  });

  it("job lock prevents concurrent runs", async () => {
    const release = (await d.kv.lock("job:sweep", 60_000))!;
    expect(await sweepUniverse(d)).toEqual({ skipped: true, reason: "LOCKED" });
    await release();
    expect(await sweepUniverse(d)).not.toHaveProperty("skipped");
  });

  it("settings: merged on defaults, validated", async () => {
    expect((await read.settingsGet(r)).bankroll).toBe(DEFAULT_SETTINGS.bankroll);
    await read.settingsPut(r, { budget: { maxPodsPerDay: 41 } });
    const st = await read.settingsGet(r);
    expect(st.budget).toMatchObject({ maxPodsPerDay: 41, maxConcurrentSandboxes: 5 });
    await expect(read.settingsPut(r, { bankroll: -5 })).rejects.toBeInstanceOf(ZodError);
    await expect(read.settingsPut(r, { nope: 1 })).rejects.toBeInstanceOf(ZodError);
    expect((await read.settingsGet(r)).bankroll).toBe(DEFAULT_SETTINGS.bankroll);
  });

  it("budget stops pods", async () => {
    await read.settingsPut(r, { budget: { maxPodsPerDay: 0 } });
    const fresh = { ...d, settings: await read.settingsGet(r) };
    expect(await researchMarket(fresh, cid("p2"), "manual")).toEqual({ skipped: true, reason: "MAX_PODS_PER_DAY" });
    await read.settingsPut(r, { budget: { maxPodsPerDay: 40 } });
  });

  it("stale `running` pods are reaped so they stop counting against the budget", async () => {
    const old = new Date(d.now() - 3 * 3_600_000);
    await d.db.insert(s.pods).values({ id: "pod_stale", conditionId: cid("p2"), startedAt: old, status: "running", trigger: "manual" });
    await d.db.insert(s.pods).values({ id: "pod_live", conditionId: cid("p2"), startedAt: new Date(d.now() - 60_000), status: "running", trigger: "manual" });
    await researchMarket({ ...d, settings: await read.settingsGet(r) }, cid("p2"), "manual");
    const st = async (i: string) => (await d.db.select().from(s.pods).where(eq(s.pods.id, i)))[0]!.status;
    expect(await st("pod_stale")).toBe("failed");
    expect(await st("pod_live")).toBe("running");
    await d.db.update(s.pods).set({ status: "failed" }).where(eq(s.pods.id, "pod_live"));
  });

  it("anthropic outage mid-pod downgrades L3 -> L2 and fails the pod", async () => {
    await d.db.insert(s.autonomyEvents).values({ fromMode: "L1", toMode: "L3", reason: "persisted", actor: "user" }); // unreachable via API this build
    const boom: AgentRunner = async () => { throw new AnthropicOutageError(5); };
    const res = await researchMarket({ ...d, settings: await read.settingsGet(r), runner: boom }, cid("p3"), "manual");
    expect(res).toMatchObject({ status: "failed", reason: "ANTHROPIC_OUTAGE" });
    const ev = (await d.db.select().from(s.autonomyEvents).orderBy(desc(s.autonomyEvents.id)).limit(1))[0]!;
    expect(ev).toMatchObject({ fromMode: "L3", toMode: "L2", reason: "ANTHROPIC_OUTAGE", actor: "auto-downgrade" });
    await setMode(d, "L1", "back"); // lowering is always allowed
    expect((await read.autonomy(r)).mode).toBe("L1");
  });

  it("pod.failed payload is scrubbed of key-shaped strings", async () => {
    let msg = "";
    const off = subscribe((e) => { if (e.type === "pod.failed") msg = (e.payload as { error: string }).error; });
    const boom = (async () => { throw new Error(`boom 0x${"ab".repeat(32)}`); }) as unknown as Deps["judge"];
    await researchMarket({ ...d, settings: await read.settingsGet(r), judge: boom }, cid("p3"), "manual");
    off?.();
    expect(msg).toContain("boom");
    expect(msg).not.toContain("ab".repeat(32));
  });

  it("resolved market: calibrate writes outcome, paperBook settles, calibration reads", async () => {
    const { p, m } = (await d.db.select({ p: s.positions, m: s.markets }).from(s.positions).innerJoin(s.markets, eq(s.markets.conditionId, s.positions.conditionId)))[0]!;
    const gone = m.conditionId, yes = p.tokenId === m.yesTokenId;
    const base = (await pm.listMarkets()).find((x) => x.condition_id === gone)!;
    const sim = {
      ...pm,
      listMarkets: async () => (await pm.listMarkets()).filter((x) => x.condition_id !== gone),
      listEvents: async () => (await pm.listEvents()).map((e) => ({ ...e, markets: e.markets.filter((x) => x.condition_id !== gone) })),
      market: async (id: string) => (id === base.id ? { ...base, open: false, closed: true, yes_price: yes ? 1 : 0 } : pm.market(id)),
    } as typeof pm;
    const d2 = { ...d, pm: sim };
    await sweepUniverse(d2);
    expect((await d.db.select().from(s.markets).where(eq(s.markets.conditionId, gone)))[0]!.status).toBe("closed");
    expect(await calibrateNightly(d2)).toMatchObject({ resolved: 1 });
    expect(await paperBook(d2)).toMatchObject({ settled: 1 });
    const pos = (await d.db.select().from(s.positions).where(eq(s.positions.id, p.id)))[0]!;
    expect(pos.closedAt).not.toBeNull();
    expect(pos.realizedPnl).toBeGreaterThan(0); // held token won
    const cal = await read.calibration(r);
    expect(cal.n).toBe(1);
    expect(cal.byCategory[m.category!]!.c).toBe(0.4);
    expect(Object.values(cal.byRoleMix).reduce((n, a) => n + a.n, 0)).toBe(1);
    const pb = await read.paperBook(r);
    expect(pb.summary.closed).toBe(1);
    expect(pb.summary.perShare.n).toBe(1);
    expect(pb.summary.perShare.realized).toBeCloseTo(pos.realizedPnl / pos.size, 9);
    expect(pb.positions.find((x) => x.id === p.id)!.result).toBe(yes ? "YES" : "NO");
  });

  it("kill drops to L0 and stops paper fills", async () => {
    expect(await kill(d)).toMatchObject({ mode: "L0", cancelled: 0, failed: [] });
    expect(await paperBook(d)).toMatchObject({ mode: "L0", filled: 0 });
  });

  it("sweep never walks the events listing (nested markets OOM a Vercel function)", async () => {
    const noEvents = { ...pm, listEvents: async () => { throw new Error("listEvents called"); } } as typeof pm;
    await expect(sweepUniverse({ ...d, pm: noEvents })).resolves.not.toThrow();
  });

  it("truncated listing does not mass-close", async () => {
    const all = await pm.listMarkets();
    const half = { ...pm, listMarkets: async () => all.slice(0, Math.floor(all.length / 2)), listEvents: async () => [] } as typeof pm;
    const d3 = { ...d, pm: half };
    expect(await sweepUniverse(d3)).toMatchObject({ closed: 0 });
    expect(await sweepUniverse(d3)).toMatchObject({ closed: 0 });
    expect((await sweepUniverse(d3) as { closed: number }).closed).toBeGreaterThan(0); // 3rd consecutive: honoured
  });

  it("missing from the filtered listing: closed only if past or inside the queried end window", async () => {
    const [base] = await d.db.select().from(s.markets).limit(1);
    const { minDays, maxDays } = d.settings.filters, day = 864e5, now = t;
    const mk = (k: string, end: number) => ({ ...base!, conditionId: cid("gone-" + k), pmId: "gone-" + k, endDate: new Date(end), status: "active" as const });
    const rows = [mk("soon", now + (minDays / 2) * day), mk("window", now + ((minDays + maxDays) / 2) * day), mk("past", now - day)];
    await d.db.insert(s.markets).values(rows);
    await d.db.insert(s.positions).values({ conditionId: cid("gone-window"), tokenId: "tok", size: 1, avgCost: 0.5 }); // held: stays open
    await sweepUniverse(d);
    const status = async (k: string) => (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, cid("gone-" + k))))[0]!.status;
    expect(await status("soon")).toBe("active");
    expect(await status("window")).toBe("active");
    expect(await status("past")).toBe("closed");
    await d.db.update(s.positions).set({ closedAt: new Date(t) }).where(eq(s.positions.conditionId, cid("gone-window")));
    await sweepUniverse(d);
    expect(await status("window")).toBe("closed");
  });

  it("buy-all needs the true leg count from Gamma: lookup failure or an extra leg rejects it", async () => {
    const buyAll = async (p: typeof pm) => { await screenAll({ ...d, pm: p }); return (await read.watchlist(r, "structural")).filter((x: any) => x.kind === "buy-all").length; };
    expect(await buyAll(pm)).toBeGreaterThan(0);
    expect(await buyAll({ ...pm, event: async () => { throw new Error("429"); } } as typeof pm)).toBe(0);
    const extra = async (id: string) => { const e = await pm.event(id); return e && { ...e, markets: [...e.markets, { ...e.markets[0]!, condition_id: "0xhidden" }] }; };
    expect(await buyAll({ ...pm, event: extra } as typeof pm)).toBe(0);
    await screenAll(d);
  });

  it("screenAll skips a busy small-cap row and an undated market", async () => {
    const [sc] = await d.db.select().from(s.screens).where(and(eq(s.screens.tier, "small-cap"), eq(s.screens.structuralFlag, false))).limit(1);
    const snapOf = async (c: string) => (await d.db.select().from(s.snapshots).where(eq(s.snapshots.conditionId, c)).orderBy(desc(s.snapshots.ts)).limit(1))[0]!;
    const n = async (c: string) => (await d.db.select().from(s.screens).where(eq(s.screens.conditionId, c))).length;
    const { id: _i, ...snap } = await snapOf(sc!.conditionId);
    await d.db.insert(s.snapshots).values({ ...snap, ts: new Date(t + 1000), vol24h: d.settings.universe.smallCapMaxVol24hUsd + 1 });
    const before = await n(sc!.conditionId);
    await screenAll(d);
    expect(await n(sc!.conditionId)).toBe(before); // busy: no new screen row

    const [base] = await d.db.select().from(s.markets).limit(1);
    const u = cid("undated");
    await d.db.insert(s.markets).values({ ...base!, conditionId: u, pmId: "undated", endDate: null, status: "active" });
    const { id: _j, ...us } = await snapOf(base!.conditionId);
    await d.db.insert(s.snapshots).values({ ...us, conditionId: u, ts: new Date(t + 1000) });
    await screenAll(d);
    expect((await d.db.select().from(s.screens).where(eq(s.screens.conditionId, u))).every((x) => x.priority === 0)).toBe(true); // pass1 days_out_of_range: never shortlisted
  });

  it("held market stays open when missing under a new baseline key (changed filter)", async () => {
    const [base] = await d.db.select().from(s.markets).limit(1);
    const c = cid("held-newkey"), { minDays, maxDays } = d.settings.filters;
    await d.db.insert(s.markets).values({ ...base!, conditionId: c, pmId: "held-newkey", endDate: new Date(t + ((minDays + maxDays) / 2) * 864e5), status: "active" });
    await d.db.insert(s.proposals).values({ thesisId: "th-held", conditionId: c, tokenId: "tok", side: "BUY", kind: "entry", sizeUsd: 1, shares: 1, limitPrice: 0.5, expectedProfit: 0, priceAtProposal: 0.5, expiresAt: new Date(t + 6e4), approveTokenHash: "a", rejectTokenHash: "b" });
    const status = async () => (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, c)))[0]!.status;
    await sweepUniverse({ ...d, settings: { ...d.settings, universe: { ...d.settings.universe, minLiquidityUsd: 1 } } }); // fresh key: no baseline
    expect(await status()).toBe("active");
    await d.db.update(s.proposals).set({ status: "rejected" }).where(eq(s.proposals.thesisId, "th-held"));
    await sweepUniverse(d);
    expect(await status()).toBe("closed");
  });

  it("no candidates: 10 min old snapshots keep L1, 20 min downgrade", async () => {
    await setMode(d, "L1", "test");
    const cats = (await d.db.select({ c: s.markets.category }).from(s.markets)).map((x) => x.c ?? "");
    const quiet = { ...d, settings: { ...d.settings, overrides: Object.fromEntries([...cats, ""].map((c) => [c, "L0" as const])) } };
    t += 10 * 60_000;
    expect(await paperBook(quiet)).toMatchObject({ candidates: 0, mode: "L1" });
    t += 10 * 60_000;
    expect(await paperBook(quiet)).toMatchObject({ mode: "L0" });
  });

  it("dead feed (no snapshot for > 5 min) downgrades L1 -> L0 even with no candidates", async () => {
    await setMode(d, "L1", "test");
    t += 10 * 60_000;
    expect(await paperBook({ ...d, pm: { ...pm, books: async () => [] } as typeof pm })).toMatchObject({ mode: "L0" }); // feed returns no books
  });

  it("publishes bus events", () => {
    for (const e of ["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.done", "thesis.created", "mode.changed", "paper.fill"]) expect(events).toContain(e);
  });
});

describe("research disabled (prod without ANTHROPIC_API_KEY)", () => {
  it("skips and writes no pod, agent-run or thesis rows", async () => {
    const n = async () => [(await d.db.select().from(s.pods)).length, (await d.db.select().from(s.agentRuns)).length, (await d.db.select().from(s.theses)).length];
    const before = await n();
    expect(await researchMarket({ ...d, runner: disabledRunner }, cid("p2"), "manual")).toEqual({ skipped: true, reason: "RESEARCH_DISABLED" });
    expect(await n()).toEqual(before);
  });
});

describe("sweep timestamp", () => {
  it("successful sweep writes kick:sweepAt", async () => {
    expect(await d.kv.get<number>("kick:sweepAt")).toBeGreaterThan(0);
  });
});

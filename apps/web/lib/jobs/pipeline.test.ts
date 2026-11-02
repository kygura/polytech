import { AnthropicOutageError, disabledRunner, fakeJudge, fakeRunner, type AgentRunner } from "@pm/agents";
import { DEFAULT_SETTINGS, DEFAULT_STEERING, ProfileFilterSchema, type ResearchProfile } from "@pm/core";
import { memoryKv } from "@pm/db";
import { createPm } from "@pm/pm";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { calibrateNightly, createProfile, deps, runProfile, kill, paperBook, read, researchMarket, researchShortlist, screenAll, setMode, snapshotBooks, subscribe, sweepUniverse, type Deps } from "./index";

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

/** `select * from markets limit 1` (heap order = the sweep's insertion order): the first stored market of the fixture listing. */
const firstMarket = async () => (await d.db.markets.getMany((await pm.listMarkets()).map((x) => x.condition_id))).slice(0, 1);
const walk = (list: () => Promise<any[]>) => async (_o: unknown, on: (ms: any[]) => Promise<void>) => { await on(await list()); return { pages: 1, complete: true }; };

describe("pipeline (fixtures + fake runner/judge)", () => {
  it("sweep maps pm -> markets", async () => {
    const rows = await d.db.markets.all();
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

  it("evidence gate: the fake judge grades no evidence, so every thesis records 0 strong facts and c <= 0.4", async () => {
    const ths = await d.db.theses.all();
    expect(ths.length).toBeGreaterThan(0);
    for (const t of ths) {
      expect((t.detail as { strongFacts?: number }).strongFacts).toBe(0);
      expect(t.c).toBeLessThanOrEqual(0.4);
    }
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
    const th = await d.db.theses.find("byCreated", {}); // insertion order (th[0] below)
    expect(th.length).toBeGreaterThan(0);
    for (const x of th) {
      expect(x.sizeUsd).toBeLessThanOrEqual(0.05 * DEFAULT_SETTINGS.bankroll + 1e-9);
      expect(x.c).toBeLessThanOrEqual(0.4 + 1e-9); // < 30 resolved
    }
    const ev = await d.db.evidence.pks();
    expect(ev.length).toBeGreaterThan(0);
    const spend = await d.db.spend.all();
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
    const before = (await d.db.orders.pks()).length;
    const again = await paperBook(d);
    expect(again).toMatchObject({ filled: 0 });
    expect((await d.db.orders.pks()).length).toBe(before);
  });

  it("job lock prevents concurrent runs", async () => {
    const release = (await d.kv.lock("job:sweep", 60_000))!;
    expect(await sweepUniverse(d)).toEqual({ skipped: true, reason: "LOCKED" });
    await release();
    expect(await sweepUniverse(d)).not.toHaveProperty("skipped");
  });

  it("snapshots keep the chain alive when oi/trades 403 (books-only, enrichment null)", async () => {
    const boom = async () => { throw new Error("GET /oi -> 403 <!DOCTYPE html>"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapIds = async () => (await d.db.snapshots.pks()).map(Number);
    const all0 = await snapIds();
    const before = Math.max(0, ...all0);
    await d.db.snapshots.updateMany(all0, { ts: new Date(d.now() - 2 * 3_600_000) }); // unchanged books are only re-recorded once the last history row is older than an hour
    const out = (await snapshotBooks({ ...d, pm: { ...pm, oi: boom, trades: boom, holders: boom } as unknown as typeof pm }, "all")) as { snapshots: number };
    warn.mockRestore();
    expect(out.snapshots).toBeGreaterThan(0);
    const fresh = await d.db.snapshots.getMany((await snapIds()).filter((id) => id > before));
    expect(fresh).toHaveLength(out.snapshots);
    expect(fresh.every((x) => x.oi === null && x.top10Share === null && x.book?.flowUnknown === true)).toBe(true);
    const bug = async () => { throw new TypeError("x is undefined"); };
    await expect(snapshotBooks({ ...d, pm: { ...pm, oi: bug } as unknown as typeof pm }, "all")).rejects.toThrow(TypeError);
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
    await d.db.pods.insert({ id: "pod_stale", conditionId: cid("p2"), startedAt: old, status: "running", trigger: "manual" });
    await d.db.pods.insert({ id: "pod_live", conditionId: cid("p2"), startedAt: new Date(d.now() - 60_000), status: "running", trigger: "manual" });
    await researchMarket({ ...d, settings: await read.settingsGet(r) }, cid("p2"), "manual");
    const st = async (i: string) => (await d.db.pods.get(i))!.status;
    expect(await st("pod_stale")).toBe("failed");
    expect(await st("pod_live")).toBe("running");
    await d.db.pods.update("pod_live", { status: "failed" });
  });

  it("anthropic outage mid-pod downgrades L3 -> L2 and fails the pod", async () => {
    await d.db.autonomyEvents.insert({ fromMode: "L1", toMode: "L3", reason: "persisted", actor: "user" }); // unreachable via API this build
    const boom: AgentRunner = async () => { throw new AnthropicOutageError(5); };
    const res = await researchMarket({ ...d, settings: await read.settingsGet(r), runner: boom }, cid("p3"), "manual");
    expect(res).toMatchObject({ status: "failed", reason: "ANTHROPIC_OUTAGE" });
    const ev = (await d.db.autonomyEvents.first("byId", {}, { order: "desc" }))!;
    expect(ev).toMatchObject({ fromMode: "L3", toMode: "L2", reason: "ANTHROPIC_OUTAGE", actor: "auto-downgrade" });
    await setMode(d, "L1", "back"); // lowering is always allowed
    expect((await read.autonomy(r)).mode).toBe("L1");
  });

  it("agents that ran out of the pod deadline fail the pod with reason TIMEOUT", async () => {
    const late: AgentRunner = async () => { throw new Error("TIMEOUT: agent source"); };
    const res = await researchMarket({ ...d, settings: await read.settingsGet(r), runner: late }, cid("p3"), "manual");
    expect(res).toMatchObject({ status: "failed", reason: "TIMEOUT" });
    expect((await d.db.pods.get((res as { podId: string }).podId))!.status).toBe("failed");
  });

  it("a timed-out pod still charges the daily spend (estimate), so the cap cannot undercount", async () => {
    const total = async () => (await d.db.spend.all()).reduce((t, x) => t + x.anthropicUsd, 0);
    const before = await total();
    const late: AgentRunner = async () => { throw new Error("TIMEOUT: agent source"); };
    expect(await researchMarket({ ...d, settings: await read.settingsGet(r), runner: late }, cid("p3"), "manual")).toMatchObject({ reason: "TIMEOUT" });
    expect(await total()).toBeGreaterThan(before);
  });

  describe("shared deadline and failed-pod skip", () => {
    const mk = (name: string, keys: string[]) => createProfile(d.db, { name, enabled: false, filter: ProfileFilterSchema.parse({ includeConditionIds: ids(keys), skipIfResearchedWithinHours: 0 }), steering: DEFAULT_STEERING, everyMin: null } as never) as Promise<ResearchProfile>;
    const pods = async () => (await d.db.pods.pks()).length;
    const match = (keys: string[]) => ids(keys).map((conditionId) => ({ conditionId }));

    it("no pod starts past a deadline shared across runs (shortlist -> profiles)", async () => {
      const deadline = d.now() + 300_000;
      const slow: AgentRunner = async (role, ...a) => { if (role === "rules") t += 250_000; return fakeRunner(role, ...a); }; // one pod burns 250 s
      const keys = ["a1", "a2", "a3"], n0 = await pods();
      // sandbox runner: 5 agents per pod against a cap of 5 means one pod per wave
      const first = await runProfile({ ...d, runner: slow, runnerKind: "sandbox" }, await mk("dl1", keys), match(keys), deadline);
      expect(first).toMatchObject({ stopped: "WINDOW" });
      const n1 = await pods();
      expect(n1 - n0).toBe(1); // second wave never started
      const second = await runProfile({ ...d, runnerKind: "sandbox" }, await mk("dl2", keys), match(keys), deadline);
      expect(second).toMatchObject({ stopped: "WINDOW", done: 0, failed: 0 });
      expect(await pods()).toBe(n1);
    });

    it("markets with a pod that failed in the last 24h are not picked again", async () => {
      await d.db.pods.insert({ id: "pod_poison", conditionId: cid("a4"), startedAt: new Date(d.now() - 20 * 3_600_000), status: "failed", trigger: "manual" });
      const n0 = await pods();
      expect(await runProfile(d, await mk("poison", ["a4"]), match(["a4"]))).toMatchObject({ candidates: 0 });
      expect(await pods()).toBe(n0);
    });
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
    const ps = await d.db.positions.find("book", [{ paper: true }, { paper: false }]); // by id
    const ms = new Map((await d.db.markets.getMany([...new Set(ps.map((x) => x.conditionId))])).map((x) => [x.conditionId, x]));
    const { p, m } = ps.filter((x) => ms.has(x.conditionId)).map((x) => ({ p: x, m: ms.get(x.conditionId)! }))[0]!; // inner join
    const gone = m.conditionId, yes = p.tokenId === m.yesTokenId;
    const base = (await pm.listMarkets()).find((x) => x.condition_id === gone)!;
    const sim = {
      ...pm,
      walkMarkets: walk(async () => (await pm.listMarkets()).filter((x) => x.condition_id !== gone)),
      listEvents: async () => (await pm.listEvents()).map((e) => ({ ...e, markets: e.markets.filter((x) => x.condition_id !== gone) })),
      market: async (id: string) => (id === base.id ? { ...base, open: false, closed: true, yes_price: yes ? 1 : 0 } : pm.market(id)),
    } as typeof pm;
    const d2 = { ...d, pm: sim };
    await sweepUniverse(d2);
    expect((await d.db.markets.get(gone))!.status).toBe("closed");
    expect(await calibrateNightly(d2)).toMatchObject({ resolved: 1 });
    expect(await paperBook(d2)).toMatchObject({ settled: 1 });
    const pos = (await d.db.positions.get(p.id))!;
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

  it("sweep from a listing cut short (429) upserts what came and closes nothing", async () => {
    const all = await pm.listMarkets();
    const cut = { ...pm, walkMarkets: async (_o: unknown, on: (m: typeof all) => Promise<void>) => { await on(all.slice(0, 1)); return { pages: 1, complete: false }; } } as unknown as typeof pm;
    const before = await d.kv.get(`sweep:listing:${d.settings.universe.minLiquidityUsd}:${d.settings.filters.minDays}:${d.settings.filters.maxDays}`);
    expect(await sweepUniverse({ ...d, pm: cut })).toMatchObject({ markets: 1, closed: 0, complete: false });
    expect(await d.kv.get(`sweep:listing:${d.settings.universe.minLiquidityUsd}:${d.settings.filters.minDays}:${d.settings.filters.maxDays}`)).toBe(before);
  });

  it("sweep never walks the events listing (nested markets OOM a Vercel function)", async () => {
    const noEvents = { ...pm, listEvents: async () => { throw new Error("listEvents called"); } } as typeof pm;
    await expect(sweepUniverse({ ...d, pm: noEvents })).resolves.not.toThrow();
  });

  it("truncated listing does not mass-close", async () => {
    const all = await pm.listMarkets();
    const half = { ...pm, walkMarkets: walk(async () => all.slice(0, Math.floor(all.length / 2))), listEvents: async () => [] } as typeof pm;
    const d3 = { ...d, pm: half };
    expect(await sweepUniverse(d3)).toMatchObject({ closed: 0 });
    expect(await sweepUniverse(d3)).toMatchObject({ closed: 0 });
    expect((await sweepUniverse(d3) as { closed: number }).closed).toBeGreaterThan(0); // 3rd consecutive: honoured
  });

  it("missing from the filtered listing: closed only if past or inside the queried end window", async () => {
    const [base] = await firstMarket();
    const { minDays, maxDays } = d.settings.filters, day = 864e5, now = t;
    const mk = (k: string, end: number) => ({ ...base!, conditionId: cid("gone-" + k), pmId: "gone-" + k, endDate: new Date(end), status: "active" as const });
    const rows = [mk("soon", now + (minDays / 2) * day), mk("window", now + ((minDays + maxDays) / 2) * day), mk("past", now - day), mk("stray", now + (minDays / 2) * day)];
    await d.db.markets.insertMany(rows);
    await d.db.positions.insert({ conditionId: cid("gone-window"), tokenId: "tok", size: 1, avgCost: 0.5 }); // held: stays open
    await d.db.marketFlags.insertMany([{ conditionId: cid("gone-soon"), pinned: true }, { conditionId: cid("gone-past"), pinned: true }]); // referenced: kept, so closing applies
    await sweepUniverse(d);
    const row = async (k: string) => (await d.db.markets.get(cid("gone-" + k))) ?? undefined;
    const status = async (k: string) => (await row(k))!.status;
    expect(await status("soon")).toBe("active");
    expect(await status("window")).toBe("active");
    expect(await status("past")).toBe("closed");
    expect(await row("stray")).toBeUndefined(); // nothing of the user's names it and the listing no longer has it: pruned
    await d.db.positions.updateMany((await d.db.positions.ids("cond", { conditionId: cid("gone-window") })).map(Number), { closedAt: new Date(t) });
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
    const run = (await d.db.screenRuns.first("byTs", {}, { order: "desc" }))!; // a row of the latest run
    const [sc] = (await d.db.screens.find("run", { ts: run.ts }, { order: "desc" })).filter((x) => x.tier === "small-cap" && x.structuralFlag === false);
    const snapOf = async (c: string) => (await d.db.snapshots.first("cond", { conditionId: c }, { order: "desc" }))!;
    const n = async (c: string) => d.db.screens.count("cond", { conditionId: c });
    const { id: _i, ...snap } = await snapOf(sc!.conditionId);
    await d.db.snapshots.insert({ ...snap, ts: new Date(t + 1000), vol24h: d.settings.universe.smallCapMaxVol24hUsd + 1 });
    const before = await n(sc!.conditionId);
    await screenAll(d);
    expect(await n(sc!.conditionId)).toBe(before); // busy: no new screen row

    const [base] = await firstMarket();
    const u = cid("undated");
    await d.db.markets.insert({ ...base!, conditionId: u, pmId: "undated", endDate: null, status: "active" });
    const { id: _j, ...us } = await snapOf(base!.conditionId);
    await d.db.snapshots.insert({ ...us, conditionId: u, ts: new Date(t + 1000) });
    await screenAll(d);
    expect((await d.db.screens.find("cond", { conditionId: u })).every((x) => x.priority === 0)).toBe(true); // pass1 days_out_of_range: never shortlisted
  });

  it("held market stays open when missing under a new baseline key (changed filter)", async () => {
    const [base] = await firstMarket();
    const c = cid("held-newkey"), { minDays, maxDays } = d.settings.filters;
    await d.db.markets.insert({ ...base!, conditionId: c, pmId: "held-newkey", endDate: new Date(t + ((minDays + maxDays) / 2) * 864e5), status: "active" });
    await d.db.proposals.insert({ thesisId: "th-held", conditionId: c, tokenId: "tok", side: "BUY", kind: "entry", sizeUsd: 1, shares: 1, limitPrice: 0.5, expectedProfit: 0, priceAtProposal: 0.5, expiresAt: new Date(t + 6e4), approveTokenHash: "a", rejectTokenHash: "b" });
    const status = async () => (await d.db.markets.get(c))!.status;
    await sweepUniverse({ ...d, settings: { ...d.settings, universe: { ...d.settings.universe, minLiquidityUsd: 1 } } }); // fresh key: no baseline
    expect(await status()).toBe("active");
    await d.db.proposals.updateMany((await d.db.proposals.ids("thesis", { thesisId: "th-held" })), { status: "rejected" });
    await sweepUniverse(d);
    expect(await status()).toBe("closed");
  });

  it("market with a recent pod stays open when missing from the listing; closes once the pod is older than 30 d", async () => {
    const [base] = await firstMarket();
    const c = cid("held-pod"), { minDays, maxDays } = d.settings.filters;
    await d.db.markets.insert({ ...base!, conditionId: c, pmId: "held-pod", endDate: new Date(t + ((minDays + maxDays) / 2) * 864e5), status: "active" });
    await d.db.pods.insert({ id: "pod_held", conditionId: c, startedAt: new Date(d.now() - 864e5), status: "done", trigger: "manual" });
    const status = async () => (await d.db.markets.get(c))!.status;
    await sweepUniverse(d);
    expect(await status()).toBe("active");
    await d.db.pods.update("pod_held", { startedAt: new Date(d.now() - 40 * 864e5) });
    await sweepUniverse(d);
    expect(await status()).toBe("closed");
  });

  it("no candidates: 10 min old snapshots keep L1, 20 min downgrade", async () => {
    await setMode(d, "L1", "test");
    const cats = (await d.db.markets.all()).map((x) => x.category ?? "");
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
    const n = async () => Promise.all([d.db.pods.pks(), d.db.agentRuns.pks(), d.db.theses.all()]).then((xs) => xs.map((x) => x.length));
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

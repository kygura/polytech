import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deps, monitor, subscribe, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

const H = 3_600_000;
let T = Date.parse("2026-10-15T12:00:00Z");
let d: Deps;
const run = async (over: Partial<Deps> = {}) => (await monitor({ ...d, now: () => T, ...over })) as { raised: number; deduped: number; suppressed: number; byKind: Record<string, number> };
const alerts = async () => (await d.db.select().from(s.alerts)).sort((a, b) => a.id - b.id);
const market = (c: string, over: Partial<typeof s.markets.$inferInsert> = {}) =>
  d.db.insert(s.markets).values({ conditionId: c, question: `Question ${c}?`, endDate: new Date(T + 30 * 864e5), status: "active", ...over }).onConflictDoNothing();
const latest = (c: string, over: Partial<typeof s.marketLatest.$inferInsert> = {}) =>
  d.db.insert(s.marketLatest).values({ conditionId: c, mid: 0.5, ...over }).onConflictDoUpdate({ target: s.marketLatest.conditionId, set: { mid: 0.5, ...over } });
const thesis = (id: string, c: string, over: Partial<typeof s.theses.$inferInsert> = {}) =>
  d.db.insert(s.theses).values({ id, conditionId: c, podId: `pod-${id}`, pHat: 0.7, c: 0.4, pPost: 0.6, side: "YES", edgeC: 5, sizeUsd: 20, createdAt: new Date(T - H), expiresAt: new Date(T + 48 * H), detail: { pYes: 0.7, pMidYes: 0.4 }, ...over });
const clear = async () => { for (const t of [s.alerts, s.theses, s.marketLatest, s.markets, s.pods, s.marketFlags]) await d.db.delete(t); await d.kv.set("monitor:state", null); await d.kv.set("monitor:at", null); };

beforeAll(async () => {
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => T });
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ALERT_WEBHOOK_URL; });

describe("monitor", () => {
  it("mid_move: |mid - thesis mid| >= midMoveC cents on a live thesis; deduped inside the cooldown, re-raised after", async () => {
    await clear();
    const events: unknown[] = [];
    const off = subscribe((e) => e.type === "alert.created" && events.push(e.payload));
    await market("m1"); await thesis("t1", "m1");
    await latest("m1", { mid: 0.44 }); // +4c < 5c
    expect((await run()).raised).toBe(0);
    await latest("m1", { mid: 0.46 }); // +6c
    expect(await run()).toMatchObject({ raised: 1, byKind: { mid_move: 1 } });
    const [a] = await alerts();
    expect(a).toMatchObject({ kind: "mid_move", conditionId: "m1", ackedAt: null });
    expect(a!.message).toContain("+6.0c");
    expect(a!.data).toMatchObject({ thesisId: "t1", midAt: 0.4, mid: 0.46 });
    expect(events).toEqual([expect.objectContaining({ kind: "mid_move", conditionId: "m1" })]);
    T += 5 * H; // cooldown is 6 h
    expect(await run()).toMatchObject({ raised: 0, deduped: 1 });
    T += 2 * H;
    expect(await run()).toMatchObject({ raised: 1 });
    expect(await alerts()).toHaveLength(2);
    off();
  });

  it("the threshold comes from settings.alerts; muted markets and expired theses are skipped", async () => {
    await clear();
    await market("m1"); await market("m2"); await market("m3");
    await thesis("t1", "m1"); await thesis("t2", "m2"); await thesis("t3", "m3", { expiresAt: new Date(T - H) });
    for (const c of ["m1", "m2", "m3"]) await latest(c, { mid: 0.47 }); // +7c each
    await d.db.insert(s.marketFlags).values({ conditionId: "m2", muted: true });
    const st = { ...d.settings, alerts: { midMoveC: 8, cooldownH: 6 } };
    expect((await run({ settings: st })).raised).toBe(0);
    expect(await run()).toMatchObject({ raised: 1, byKind: { mid_move: 1 } }); // only m1: m2 is muted, m3's thesis expired
    expect((await alerts())[0]!.conditionId).toBe("m1");
  });

  it("catalyst_passed reuses shouldReResearch: a catalyst dated after the thesis and before now", async () => {
    await clear();
    await market("m1"); await market("m2");
    await thesis("t1", "m1", { createdAt: new Date(T - 5 * 864e5), catalysts: ["2026-10-14 FOMC minutes"] });
    await thesis("t2", "m2", { createdAt: new Date(T - 5 * 864e5), catalysts: ["2026-10-30 CPI print"] }); // still ahead
    await latest("m1", { mid: 0.4 }); await latest("m2", { mid: 0.4 });
    expect(await run()).toMatchObject({ raised: 1, byKind: { catalyst_passed: 1 } });
    expect((await alerts())[0]).toMatchObject({ kind: "catalyst_passed", conditionId: "m1" });
  });

  it("run_failed: pods failed since the last pass, once", async () => {
    await clear();
    await market("m1");
    await d.db.insert(s.pods).values({ id: "pod_x", conditionId: "m1", status: "failed", trigger: "manual", startedAt: new Date(T - 10 * 60_000) });
    await d.db.insert(s.pods).values({ id: "pod_ok", conditionId: "m1", status: "done", trigger: "manual", startedAt: new Date(T - 10 * 60_000) });
    expect(await run()).toMatchObject({ raised: 1, byKind: { run_failed: 1 } });
    T += 10 * 60_000;
    expect((await run()).raised).toBe(0); // same pod is inside the overlap window but deduped
    expect(await alerts()).toHaveLength(1);
  });

  it("structural: a market newly flagged is raised once while the flag persists; a cleared and re-set flag is a new flag after the cooldown", async () => {
    await clear();
    await market("m1"); await latest("m1", { structural: ["overround"] });
    expect(await run()).toMatchObject({ raised: 1, byKind: { structural: 1 } });
    T += 7 * H;
    expect((await run()).raised).toBe(0); // still flagged: not new
    await latest("m1", { structural: [] });
    await run();
    await latest("m1", { structural: ["monotonicity_violation"] });
    expect((await run()).raised).toBe(1);
  });

  it("new_candidate: enters the top 20 by priority with hysteresis (stays 'in' until rank 30), not for researched markets", async () => {
    await clear();
    const ids = Array.from({ length: 35 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    for (const [i, c] of ids.entries()) { await market(c); await latest(c, { priority: 1 - i / 100 }); } // c00 best
    await thesis("tx", "c05"); // researched: never a "new candidate"
    const st = { ...d.settings, alerts: { midMoveC: 50, cooldownH: 0 } };
    expect(await run({ settings: st })).toMatchObject({ raised: 19, byKind: { new_candidate: 19 } }); // top 20 minus the researched one
    T += 1000;
    expect((await run({ settings: st })).raised).toBe(0);
    await latest("c03", { priority: 0.715 }); // falls to rank 29: still "in" (<= 30)
    T += 1000;
    await run({ settings: st });
    await latest("c03", { priority: 0.99 }); // back on top: not a new entry
    T += 1000;
    expect((await run({ settings: st })).raised).toBe(0);
    await latest("c34", { priority: 0.995 }); // a genuinely new entrant
    T += 1000;
    expect(await run({ settings: st })).toMatchObject({ raised: 1 });
    expect((await alerts()).at(-1)!.conditionId).toBe("c34");
  });

  it("caps a pass at 20 alerts plus one summary; the remainder is raised on the next pass", async () => {
    await clear();
    for (let i = 0; i < 30; i++) { const c = `s${String(i).padStart(2, "0")}`; await market(c); await latest(c, { structural: ["overround"] }); }
    expect(await run()).toMatchObject({ raised: 21, suppressed: 10 });
    let all = await alerts();
    expect(all.filter((a) => a.conditionId).length).toBe(20);
    expect(all.filter((a) => !a.conditionId)).toEqual([expect.objectContaining({ kind: "structural", message: "10 more alerts not shown" })]);
    expect(await run()).toMatchObject({ raised: 10, suppressed: 0 }); // no second summary, the rest goes out
    all = await alerts();
    expect(new Set(all.filter((a) => a.conditionId).map((a) => a.conditionId)).size).toBe(30);
  });

  it("ALERT_WEBHOOK_URL: one POST {text} per alert with a 5 s timeout; a failing hook never fails the pass", async () => {
    await clear();
    await market("m1"); await market("m2");
    await latest("m1", { structural: ["overround"] }); await latest("m2", { structural: ["overround"] });
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => { throw new Error("down"); });
    vi.stubGlobal("fetch", fetchMock);
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/alerts";
    expect((await run()).raised).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/alerts");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ text: expect.stringContaining("structural overround") });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await d.db.select().from(s.alerts).where(eq(s.alerts.kind, "structural"))).toHaveLength(2);
  });

  it("is locked: a concurrent pass is skipped", async () => {
    const rel = (await d.kv.lock("job:monitor", 60_000))!;
    expect(await monitor(d)).toEqual({ skipped: true, reason: "LOCKED" });
    await rel();
  });
});

import { brier, fitExtremize, logLoss, paperPnl } from "@pm/core";
import { memoryKv, schema as s } from "@pm/db";
import { createPm } from "@pm/pm";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { calibrateNightly, deps, getSettings, journalNightly, putSettings, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

const DAY = 864e5;
let T = Date.parse("2026-10-15T12:00:00Z");
let d: Deps;
const fresh = async () => ({ ...d, now: () => T, settings: await getSettings(d.db) });
const jr = async (id: string) => (await d.db.select().from(s.journal).where(eq(s.journal.thesisId, id)))[0]!;

async function seed(id: string, o: { c?: string; at?: number; pYes?: number; mid?: number; side?: "YES" | "NO"; k?: number; stake?: number; result?: "YES" | "NO"; category?: string; liquidity?: number; probs?: (number | null)[]; model?: string } = {}) {
  const c = o.c ?? `c-${id}`, at = o.at ?? T - 10 * DAY, pYes = o.pYes ?? 0.7, side = o.side ?? "YES";
  await d.db.insert(s.markets).values({ conditionId: c, question: `Q ${id}?`, category: o.category ?? "politics", liquidity: o.liquidity ?? 12_000, status: o.result ? "resolved" : "active", endDate: new Date(T + DAY) }).onConflictDoNothing();
  await d.db.insert(s.pods).values({ id: `pod-${id}`, conditionId: c, status: "done", trigger: "manual" });
  const roles = ["base", "contrarian", "rules", "judge"];
  await d.db.insert(s.agentRuns).values((o.probs ?? [0.6, 0.8, null]).map((p, i) => ({ podId: `pod-${id}`, role: roles[i]!, model: "m", status: "ok", outputJson: { probability: p } })).concat([{ podId: `pod-${id}`, role: "judge", model: "m", status: "ok", outputJson: { probability: 0.99 } }])); // the judge's own row never counts as blind
  await d.db.insert(s.theses).values({
    id: id, conditionId: c, podId: `pod-${id}`, pHat: side === "YES" ? pYes : 1 - pYes, c: 0.4, pPost: 0.6, side, edgeC: 6, sizeUsd: o.stake ?? 25, createdAt: new Date(at), expiresAt: new Date(at + 3 * DAY),
    detail: { pYes, pMidYes: o.mid ?? 0.5, k: o.k ?? 0.55, e: 0.055, model: o.model ?? "claude-judge" },
  });
  if (o.result) await d.db.insert(s.outcomes).values({ conditionId: c, resolvedAt: new Date(T - DAY), result: o.result }).onConflictDoNothing();
  return c;
}

beforeAll(async () => {
  d = await deps({ pm: createPm({ fixtures: true }), kv: memoryKv(), now: () => T });
}, 60_000);

describe("journal", () => {
  it("one row per thesis: estimate, blind mean, mid, liquidity, R, side, stake, judge model, category", async () => {
    await seed("t-open", { probs: [0.6, 0.8, null], pYes: 0.7, mid: 0.5, k: 0.55, stake: 25, category: "crypto", liquidity: 7777, model: "judge-x", at: T - 2 * 3_600_000 });
    const out = await journalNightly(await fresh());
    expect(out.upserted).toBe(1);
    expect(await jr("t-open")).toMatchObject({
      conditionId: "c-t-open", category: "crypto", model: "judge-x", pHat: 0.7, midAt: 0.5, liquidityAt: 7777, side: "YES", stake: 25,
      result: null, resolvedAt: null, brierModel: null, paperPnl: null, drift24h: null, drift7d: null,
    });
    expect((await jr("t-open")).pPre).toBeCloseTo(0.7, 12); // mean of 0.6 and 0.8; rules reader (null) and the judge row excluded
    expect((await jr("t-open")).r).toBeCloseTo(0.055 / 0.55, 12);
  });

  it("a NO thesis keeps the YES-side estimate", async () => {
    await seed("t-no", { side: "NO", pYes: 0.2, mid: 0.4, k: 0.7, at: T - 2 * 3_600_000 });
    await journalNightly(await fresh());
    expect(await jr("t-no")).toMatchObject({ pHat: 0.2, side: "NO", midAt: 0.4 });
  });

  it("resolved: result, Brier (model / market / pre-reveal), log loss, paper P&L", async () => {
    await seed("t-win", { result: "YES", pYes: 0.8, mid: 0.6, k: 0.5, stake: 20, probs: [0.7, 0.9, null] });
    await seed("t-lose", { result: "NO", pYes: 0.8, mid: 0.6, k: 0.5, stake: 20, probs: [0.7, 0.9, null] });
    await journalNightly(await fresh());
    const w = await jr("t-win"), l = await jr("t-lose");
    expect(w).toMatchObject({ result: "YES" });
    expect(w.brierModel).toBeCloseTo(brier(0.8, 1), 12);
    expect(w.brierMarket).toBeCloseTo(brier(0.6, 1), 12);
    expect(w.brierPre).toBeCloseTo(brier(0.8, 1), 12); // mean(0.7, 0.9)
    expect(w.logLoss).toBeCloseTo(logLoss(0.8, 1), 12);
    expect(w.paperPnl).toBeCloseTo(paperPnl({ side: "YES", stake: 20, aEff: 0.5, outcome: 1 }), 12);
    expect(l.paperPnl).toBeCloseTo(-20, 12);
    expect(l.resolvedAt).toBeInstanceOf(Date);
  });

  it("drift 24h / 7d fill from snapshot history once their time has come, and are never recomputed", async () => {
    const at = T - 8 * DAY;
    const c = await seed("t-drift", { at, pYes: 0.7, mid: 0.5 });
    await d.db.insert(s.snapshots).values([
      { conditionId: c, ts: new Date(at + DAY + 3_600_000), mid: 0.56 }, // +24h: market moved toward the estimate
      { conditionId: c, ts: new Date(at + 7 * DAY - 3_600_000), mid: 0.45 }, // +7d: and back past the start
    ]);
    await journalNightly(await fresh());
    const j = await jr("t-drift");
    expect(j.drift24h).toBeCloseTo(0.06, 12);
    expect(j.drift7d).toBeCloseTo(-0.05, 12);
    await d.db.delete(s.snapshots);
    await journalNightly(await fresh());
    expect((await jr("t-drift")).drift24h).toBeCloseTo(0.06, 12);
    // a fresh thesis has nothing to measure yet
    expect((await jr("t-open")).drift24h).toBeNull();
  });

  it("a resolved row whose 7d window has passed is final even without drift7d (it resolved before day 7)", async () => {
    await seed("t-early", { result: "YES", at: T - 12 * DAY });
    await journalNightly(await fresh());
    expect((await jr("t-early")).drift7d).toBeNull(); // no snapshots near day 7
    await d.db.update(s.journal).set({ stake: 999 }).where(eq(s.journal.thesisId, "t-early"));
    await journalNightly(await fresh());
    expect((await jr("t-early")).stake).toBe(999); // not reprocessed (it would be rewritten to 25)
  });

  it("is idempotent", async () => {
    const n = async () => (await d.db.select().from(s.journal)).length;
    const before = await n();
    await journalNightly(await fresh());
    expect(await n()).toBe(before);
  });
});

describe("extremize suggestion", () => {
  it("needs 30 resolved rows; then suggests the fitted k when it is >= 0.05 away from the current one, and clears it when it is not", async () => {
    expect((await getSettings(d.db)).suggested).toBeNull();
    // underconfident model: says 0.7, YES happens 90% of the time -> k > 1
    for (let i = 0; i < 40; i++) await seed(`fit${i}`, { pYes: 0.7, result: i % 10 === 0 ? "NO" : "YES", stake: 0 });
    const out = await journalNightly(await fresh());
    const rows = await d.db.select({ pHat: s.journal.pHat, result: s.journal.result }).from(s.journal).where(eq(s.journal.category, "politics"));
    const k = fitExtremize(rows.filter((r) => r.result).map((r) => ({ pHat: r.pHat!, result: r.result as "YES" | "NO" })));
    expect(k).not.toBeNull();
    expect(out.suggested).toBe(k);
    const sug = (await getSettings(d.db)).suggested!;
    expect(sug.extremize).toBe(k);
    expect(sug.n).toBe(out.resolved);
    expect(sug.extremize).toBeGreaterThan(1.05);
    expect(Date.parse(sug.at)).toBe(T);
    // the operator applies it: the suggestion is no longer warranted
    await putSettings(d.db, { extremize: k });
    expect((await journalNightly(await fresh())).suggested).toBeNull();
    expect((await getSettings(d.db)).suggested).toBeNull();
  });

  it("calibrateNightly runs the journal and reports it", async () => {
    const out = (await calibrateNightly(await fresh())) as { journal: { theses: number } };
    expect(out.journal.theses).toBeGreaterThan(40);
  });
});

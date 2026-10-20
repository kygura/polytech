import { fakeJudge, fakeRunner } from "@pm/agents";
import { memoryKv, schema as s } from "@pm/db";
import { createPm, type Market } from "@pm/pm";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deps, sweepUniverse, type Deps } from "./index";

process.env.PGLITE_DIR = "memory://";

const fx = createPm({ fixtures: true });
/** The fixture pm with every walked market overlaid with `patch` (what Gamma "says" now; patches persist across tests like the real world does). */
const patch = new Map<string, Partial<Market>>();
const edit = (m: Market): Market => ({ ...m, ...patch.get(m.condition_id) });
const clobMarket = vi.fn(fx.clobMarket);
const pm = { ...fx, clobMarket, walkMarkets: (o: Parameters<typeof fx.walkMarkets>[0], on: (ms: Market[]) => Promise<void> | void) => fx.walkMarkets(o, (page) => on(page.map(edit))) } as typeof fx;
let d: Deps, ids: string[];
const sweep = async () => (await sweepUniverse(d)) as { markets: number; written: number; newMarkets: number; feesFetched: number };
const row = async (c: string) => (await d.db.select().from(s.markets).where(eq(s.markets.conditionId, c)))[0]!;

beforeAll(async () => {
  d = await deps({ pm, kv: memoryKv(), now: () => Date.parse("2026-10-15T12:00:00Z"), runner: fakeRunner, judge: fakeJudge });
  ids = (await fx.listMarkets({ closed: false })).map((m) => m.condition_id);
}, 60_000);

describe("incremental sweep", () => {
  it("first sweep writes everything and stores liquidity, rules hash, resolution source, augmented flag, fee from the fee schedule", async () => {
    const [feeId, freeId, plainId] = ids as [string, string, string];
    patch.set(feeId, { fee_schedule: { rate: 0.07, exponent: 2, taker_only: true }, fee_bps: 700 });
    patch.set(freeId, { fees_enabled: false, fee_schedule: undefined, fee_bps: 0 });
    patch.set(plainId, { neg_risk_augmented: true });
    const out = await sweep();
    expect(out.written).toBe(out.markets);
    expect(out.newMarkets).toBe(out.markets);
    const rows = await d.db.select().from(s.markets);
    expect(rows.every((r) => r.rulesHash?.length === 64 && r.resolutionSource && r.liquidity != null)).toBe(true);
    expect(rows.some((r) => r.resolutionSource === "official_data")).toBe(true); // fixture rules cite "the official data release"
    expect((await row(feeId)).feeRate).toBe(0.07);
    expect((await row(feeId)).feeExponent).toBe(2); // the curve exponent is stored beside the rate
    expect((await row(freeId)).feeRate).toBe(0);
    expect((await row(freeId)).feeExponent).toBeNull(); // no schedule: null = 1
    expect((await row(plainId)).negRiskAugmented).toBe(true);
    // gamma-priced markets never asked the CLOB; the rest did (fee-free markets answer without `fd`)
    expect(clobMarket.mock.calls.map((c) => c[0])).not.toContain(feeId);
    expect(clobMarket.mock.calls.map((c) => c[0])).not.toContain(freeId);
    expect(out.feesFetched).toBeGreaterThan(0);
  });

  it("an identical second sweep updates 0 rows", async () => {
    const out = await sweep();
    expect(out.written).toBe(0);
    expect(out.newMarkets).toBe(0);
  });

  it("liquidity / volume rewrite only on a > 5% move (or null -> value)", async () => {
    const [a, b] = ids as [string, string];
    const base = (await row(a)).liquidity!, vol = (await row(a)).vol24h!;
    patch.set(a, { liquidity: base * 1.03, volume_24h: vol * 0.97 });
    expect((await sweep()).written).toBe(0);
    expect((await row(a)).liquidity).toBe(base);
    patch.set(a, { liquidity: base * 1.1, volume_24h: vol * 0.97 });
    expect((await sweep()).written).toBe(1);
    expect((await row(a)).liquidity).toBeCloseTo(base * 1.1);
    patch.set(b, { volume_24h: ((await row(b)).vol24h || 1000) * 10 });
    expect((await sweep()).written).toBe(1);
    await d.db.update(s.markets).set({ liquidity: null }).where(eq(s.markets.conditionId, b));
    expect((await sweep()).written).toBe(1); // null -> value
    expect((await row(b)).liquidity).not.toBeNull();
    expect((await sweep()).written).toBe(0);
  });

  it("resolution source is recomputed only when the rules hash changes", async () => {
    const c = ids[2]!;
    await d.db.update(s.markets).set({ resolutionSource: "subjective" }).where(eq(s.markets.conditionId, c)); // hash unchanged: the stored value is trusted
    expect((await sweep()).written).toBe(0);
    expect((await row(c)).resolutionSource).toBe("subjective");
    patch.set(c, { ...patch.get(c), rules: `${(await row(c)).rules} Resolves per the Bureau of Labor Statistics CPI release.` });
    expect((await sweep()).written).toBe(1);
    const r = await row(c);
    expect(r.resolutionSource).toBe("official_data");
    expect(r.rules).toContain("Bureau of Labor Statistics");
  });

  it("a changed question / status / tags is written", async () => {
    const c = ids[3]!;
    const r = await row(c);
    patch.set(c, { question: `${r.question} (updated)`, tags: [...r.tags, "extra"] });
    expect((await sweep()).written).toBe(1);
    expect((await row(c)).tags).toContain("extra");
  });
});

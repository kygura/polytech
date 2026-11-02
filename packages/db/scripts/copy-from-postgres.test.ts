import { asc, getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, migrate } from "../src/client";
import * as s from "../src/schema";
import { convertRows, insertRows, rowsPerChunk, tablesInFkOrder } from "./convert";

// Rows shaped like postgres-js returns them: timestamptz -> Date, date -> Date at UTC midnight, int8 -> string, jsonb -> parsed.
const t0 = new Date("2026-10-15T12:34:56.789Z");
const market = {
  condition_id: "c1", event_id: null, question: "q?", category: "politics", tags: ["a", "b"], end_date: t0, neg_risk_group: null,
  fee_rate: 0.02, fee_exponent: null, status: "active", pm_id: "123", yes_token_id: "y", no_token_id: "n", vol_24h: 1234.5, tick_size: 0.01,
  liquidity: "5000.25", rules_hash: "h", heuristic_r: 0.7, resolution_source: "official_data", neg_risk_augmented: true,
  rules_text: "dropped in 0012", // a column the schema no longer has
};
const set = {
  id: "7f0c6c9e-3d55-4a5e-9a51-0d6a2f6e1a01", event_id: "e1", kind: "buy-all", legs: [{ conditionId: "c1", token: "y", shares: 5, limit: 0.31, price: 0.3 }],
  shares: 5, total_cost: 1.55, edge: 0.1, status: "filled", created_at: t0, expires_at: new Date(t0.getTime() + 60_000), decided_at: t0, decided_via: "web",
  approve_token_hash: "", reject_token_hash: "r", failed_leg: null, error: null, fallback_reason: null,
};
const order = {
  id: "o1", thesis_id: `set:${set.id}`, idempotency_key: `set:${set.id}:0`, condition_id: "c1", token_id: "y", side: "BUY", limit_price: 0.31, size: 5,
  mode_at_send: "L1", approval: "user", status: "filled", clob_order_id: null, expires_at: null, paper: false, attempt: 0, created_at: t0, set_id: set.id, proposal_id: null,
};
const proposal = {
  id: "2b9f4a7e-8c1d-4f3a-b6e2-5d7c9a0e1f02", thesis_id: "t1", condition_id: "c1", token_id: "y", side: "BUY", kind: "entry", size_usd: 10, shares: 20,
  limit_price: 0.5, expected_profit: 1, price_at_proposal: 0.5, created_at: t0, expires_at: t0, status: "sent", decided_at: t0, decided_via: "push",
  approve_token_hash: "a", reject_token_hash: "r", order_id: "o1", error: null, fallback_reason: null, exit_reason: null,
};
const alert = (id: number) => ({ id: String(id), condition_id: "c1", kind: "mid_move", message: `m${id}`, data: { from: 0.4, to: 0.5 }, created_at: t0, acked_at: null });

describe("convertRows", () => {
  it("maps Postgres columns onto drizzle keys and drops columns the schema lost", () => {
    const { rows, dropped, missing } = convertRows(s.markets, [market]);
    expect(dropped).toEqual(["rules_text"]);
    expect(missing).toEqual([]);
    expect(rows[0]).toMatchObject({ conditionId: "c1", eventId: null, tags: ["a", "b"], endDate: t0, liquidity: 5000.25, negRiskAugmented: true });
    expect(rows[0]).not.toHaveProperty("rules_text");
    expect(rows[0]).not.toHaveProperty("condition_id");
  });

  it("date -> YYYY-MM-DD, int8 strings -> numbers, booleans, json and nulls as they are", () => {
    expect(convertRows(s.spend, [{ day: new Date("2026-10-15"), anthropic_usd: 1.5, exa_calls: 3, sandbox_s: 0 }]).rows[0])
      .toEqual({ day: "2026-10-15", anthropicUsd: 1.5, exaCalls: 3, sandboxS: 0 });
    expect(convertRows(s.alerts, [alert(42)]).rows[0]).toMatchObject({ id: 42, data: { from: 0.4, to: 0.5 }, createdAt: t0, ackedAt: null });
    const run = { id: "9", pod_id: "p1", role: "judge", model: "m", status: "ok", output_json: [1, "x", { y: null }], usage: null, duration_s: 1.25,
      started_at: t0, finished_at: null, tool_calls: [{ ts: 1, name: "web_search", input: "q", ok: true }] };
    expect(convertRows(s.agentRuns, [run]).rows[0]).toEqual({ id: 9, podId: "p1", role: "judge", model: "m", status: "ok", outputJson: [1, "x", { y: null }],
      usage: null, durationS: 1.25, startedAt: t0, finishedAt: null, toolCalls: [{ ts: 1, name: "web_search", input: "q", ok: true }] });
    expect(convertRows(s.marketFlags, [{ condition_id: "c1", pinned: false, muted: true }]).rows[0]).toEqual({ conditionId: "c1", pinned: false, muted: true });
    expect(convertRows(s.settings, [{ id: 1, data: { bankroll: 1000, nested: { a: [1] } } }]).rows[0]).toEqual({ id: 1, data: { bankroll: 1000, nested: { a: [1] } } });
  });

  it("reports schema columns Postgres lacks and non-finite numbers", () => {
    const { rows, missing, nonFinite } = convertRows(s.triage, [{ condition_id: "c1", verdict: "skip", score: NaN, reason: "r", failed_rules: [], created_at: t0 }]);
    expect(missing).toEqual(["model"]);
    expect(nonFinite).toEqual(["score"]);
    expect(rows[0]).toEqual({ conditionId: "c1", verdict: "skip", score: null, reason: "r", failedRules: [], createdAt: t0 });
  });

  it("throws on values the column can't hold", () => {
    expect(() => convertRows(s.alerts, [{ ...alert(1), id: "9007199254740993" }])).toThrow(/alerts\.id/);
    expect(() => convertRows(s.marketFlags, [{ condition_id: "c1", pinned: "t", muted: false }])).toThrow(/market_flags\.pinned/);
    expect(() => convertRows(s.alerts, [{ ...alert(1), created_at: "not a date" }])).toThrow(/alerts\.created_at/);
    expect(() => convertRows(s.snapshots, [{ id: "1", condition_id: "c1", ts: t0, mid: "abc" }])).toThrow(/snapshots\.mid/);
  });
});

describe("tablesInFkOrder / rowsPerChunk", () => {
  it("lists every table once, referenced tables first", () => {
    const names = tablesInFkOrder().map(getTableName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["markets", "snapshots", "spend", "kv", "proposal_sets", "orders", "proposals"]));
    expect(names.length).toBe((Object.values(s) as unknown[]).filter((t) => is(t, SQLiteTable)).length);
    expect(names.indexOf("proposal_sets")).toBeLessThan(names.indexOf("orders"));
    expect(names.indexOf("orders")).toBeLessThan(names.indexOf("proposals"));
  });

  it("keeps each INSERT under the bound-parameter limit", () => {
    for (const t of tablesInFkOrder()) {
      const n = rowsPerChunk(t);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(500);
      expect(n * Object.keys(getTableColumns(t)).length).toBeLessThanOrEqual(32_766);
    }
  });
});

describe("copy into libSQL (:memory:)", () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL; // never a hosted database from a test
    process.env.DB_FILE = ":memory:";
    await migrate();
  }, 60_000);

  it("inserts converted rows in FK order, reads them back typed, and a rerun inserts nothing", async () => {
    const db = getDb();
    const src = new Map<unknown, Record<string, unknown>[]>([
      [s.markets, [market]], [s.proposalSets, [set]], [s.orders, [order]], [s.proposals, [proposal]],
      [s.spend, [{ day: new Date("2026-10-15"), anthropic_usd: 1.5, exa_calls: 3, sandbox_s: 2.5 }]],
      [s.alerts, Array.from({ length: 1201 }, (_, i) => alert(i + 1))], // 3 chunks of 500
    ]);
    const copy = async () => {
      let n = 0;
      for (const t of tablesInFkOrder()) { const rows = src.get(t); if (rows) n += await insertRows(db, t, convertRows(t, rows).rows); }
      return n;
    };
    expect(rowsPerChunk(s.alerts)).toBe(500);
    expect(await copy()).toBe(1 + 1 + 1 + 1 + 1 + 1201);
    expect(await copy()).toBe(0);

    expect(await db.select().from(s.markets)).toEqual([{
      conditionId: "c1", eventId: null, question: "q?", category: "politics", tags: ["a", "b"], endDate: t0, negRiskGroup: null, feeRate: 0.02, feeExponent: null,
      status: "active", pmId: "123", yesTokenId: "y", noTokenId: "n", vol24h: 1234.5, tickSize: 0.01, liquidity: 5000.25, rulesHash: "h", heuristicR: 0.7,
      resolutionSource: "official_data", negRiskAugmented: true,
    }]);
    expect(await db.select().from(s.proposalSets)).toEqual([{
      id: set.id, eventId: "e1", kind: "buy-all", legs: set.legs, shares: 5, totalCost: 1.55, edge: 0.1, status: "filled", createdAt: t0, expiresAt: set.expires_at,
      decidedAt: t0, decidedVia: "web", approveTokenHash: "", rejectTokenHash: "r", failedLeg: null, error: null, fallbackReason: null,
    }]);
    expect(await db.select().from(s.orders)).toMatchObject([{ id: "o1", setId: set.id, paper: false, attempt: 0, expiresAt: null, createdAt: t0 }]);
    expect(await db.select().from(s.proposals)).toMatchObject([{ id: proposal.id, orderId: "o1", status: "sent", expiresAt: t0 }]);
    expect(await db.select().from(s.spend)).toEqual([{ day: "2026-10-15", anthropicUsd: 1.5, exaCalls: 3, sandboxS: 2.5 }]);
    const alerts = await db.select().from(s.alerts).orderBy(asc(s.alerts.id));
    expect(alerts).toHaveLength(1201);
    expect(alerts[1200]).toEqual({ id: 1201, conditionId: "c1", kind: "mid_move", message: "m1201", data: { from: 0.4, to: 0.5 }, createdAt: t0, ackedAt: null });
    // the autoincrement sequence continues after the copied ids
    const [next] = await db.insert(s.alerts).values({ kind: "k", message: "new" }).returning({ id: s.alerts.id });
    expect(next?.id).toBe(1202);
  });

  it("refuses an order whose set is missing (FKs are on), so the order matters", async () => {
    const db = getDb();
    const orphan = convertRows(s.orders, [{ ...order, id: "o2", idempotency_key: "k2", set_id: "00000000-0000-0000-0000-000000000000" }]).rows;
    await expect(insertRows(db, s.orders, orphan)).rejects.toThrow();
  });
});

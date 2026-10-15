import { anthropicJudge, classifyR, fakeJudge, pickRunner, type AgentRunner, type Judge } from "@pm/agents";
import { feeRateFor, type Market, type Snapshot } from "@pm/core";
import { getDb, getKv, migrate, schema as s, type Db, type Kv } from "@pm/db";
import { createPm, type Pm } from "@pm/pm";
import { getSettings, type AppSettings } from "./settings";

export type Deps = {
  db: Db;
  kv: Kv;
  pm: Pm;
  now: () => number; // epoch ms
  settings: AppSettings;
  runner: AgentRunner;
  judge: Judge;
  /** LLM researchability R in 0..1; absent => deterministic heuristic from rules text. */
  rScore?: (rules: string) => Promise<number>;
};
export type Skipped = { skipped: true; reason: string };

export const DAY = 86_400_000;
/** Fixture universe is anchored here (packages/pm/scripts/gen-fixtures.ts). */
const FIXTURE_NOW = Date.parse("2026-10-15T12:00:00Z");

const t0 = Date.now();
/** Wall clock; with PM_FIXTURES=1 it starts at FIXTURE_NOW (fixtures are dated around it) and stays monotonic. */
export const defaultNow = () => (process.env.PM_FIXTURES === "1" ? FIXTURE_NOW + (Date.now() - t0) : Date.now());

let ready: Promise<Db> | undefined;
/** getDb(), migrated once per process when running on local PGlite (Neon is migrated at deploy). */
export const dbReady = () => (ready ??= process.env.DATABASE_URL ? Promise.resolve(getDb()) : migrate());

/** Production wiring. Tests/seed override pieces via `over`. */
export async function deps(over: Partial<Deps> = {}): Promise<Deps> {
  const db = over.db ?? (await dbReady());
  const key = process.env.ANTHROPIC_API_KEY;
  const client = key && !over.judge ? new (await import("@anthropic-ai/sdk")).default() : undefined;
  return {
    db,
    kv: over.kv ?? getKv(),
    pm: over.pm ?? createPm(),
    now: over.now ?? defaultNow,
    settings: over.settings ?? (await getSettings(db)),
    runner: over.runner ?? (await pickRunner()).runner,
    judge: over.judge ?? (client ? anthropicJudge(client) : fakeJudge),
    rScore: over.rScore ?? (client ? async (rules) => (await classifyR(rules, client)).R : undefined),
  };
}

/** kv lock around a job. Held elsewhere => `{skipped}`. Always released. */
export async function withLock<T>(d: Pick<Deps, "kv">, name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | Skipped> {
  const release = await d.kv.lock(`job:${name}`, ttlMs);
  if (!release) return { skipped: true, reason: "LOCKED" };
  try {
    return await fn();
  } finally {
    await release();
  }
}

export const groupBy = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};
export const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

// ---- db row <-> core shapes ----
type MarketRow = typeof s.markets.$inferSelect;
type SnapRow = typeof s.snapshots.$inferSelect;

const OPEN = new Set(["active", "disputed", "not_accepting"]);
export const isOpenStatus = (st: string) => OPEN.has(st);

export const toMarket = (r: MarketRow): Market => ({
  conditionId: r.conditionId,
  eventId: r.eventId ?? r.conditionId,
  question: r.question,
  rules: r.rules,
  category: r.category ?? "other",
  tags: r.tags,
  endDate: r.endDate?.getTime() ?? 0,
  negRiskGroup: r.negRiskGroup,
  feeRate: r.feeRate,
  open: isOpenStatus(r.status),
  acceptingOrders: r.status !== "not_accepting",
  inDispute: r.status === "disputed",
});

export const feeOf = (m: Pick<Market, "category" | "feeRate">) => feeRateFor(m.category, m.feeRate).rate;

export const toSnap = (r: SnapRow): Snapshot => ({
  conditionId: r.conditionId,
  ts: r.ts.getTime(),
  bids: r.book?.bids ?? [],
  asks: r.book?.asks ?? [],
  vol24h: r.vol24h ?? 0,
  oi: r.oi ?? 0,
  top10Share: r.top10Share ?? 0,
  lastTradeTs: r.lastTradeTs?.getTime() ?? null,
});

export const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);

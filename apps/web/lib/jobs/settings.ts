import { DEFAULT_SETTINGS, MODES, type Settings } from "@pm/core";
import { schema as s, type Db } from "@pm/db";
import { z } from "zod";

const num = z.number().finite();
const nonneg = num.min(0);
const mode = z.enum(MODES);

const AppSettingsSchema = z.strictObject({
  filters: z.strictObject({
    minDays: nonneg, maxDays: nonneg, minDepthUsd: nonneg, depthCents: nonneg, excludedCategories: z.array(z.string()),
  }),
  sizeTargets: z.strictObject({ smallCap: nonneg, size: nonneg }),
  slippageCents: nonneg,
  cCoef: nonneg,
  crowdBonus: nonneg,
  tDecayDays: num.positive(),
  bankroll: num.positive(),
  kelly: num.min(0).max(1),
  capFrac: num.min(0).max(1),
  minEdge: nonneg,
  rAnnCap: num.positive(),
  budget: z.strictObject({
    maxPodsPerDay: nonneg, maxConcurrentSandboxes: nonneg, sandboxTimeoutMin: num.positive(), exaCallsPerPod: nonneg, dailySpendCapUsd: nonneg,
  }),
  models: z.record(z.string(), z.string()),
  limits: z.strictObject({
    perTradeUsd: nonneg, perTradePct: nonneg, perMarket: nonneg, perEvent: nonneg, perCategory: nonneg,
    totalOpen: nonneg, dailyNotional: nonneg, dailyLoss: nonneg,
    categoryThreshold: num.min(0).max(1), // thesis c must exceed this to qualify
    l3: z.strictObject({ perTradeUsd: nonneg, dailyNotional: nonneg, categoryAllowlist: z.array(z.string()), structuralAuto: z.boolean() }),
  }),
  overrides: z.record(z.string(), mode), // category -> mode; can only lower (effectiveMode)
});
export type AppSettings = Settings & z.infer<typeof AppSettingsSchema>;

// Placeholder limit values (SPEC leaves defaults open): derived from B=1000 and capFrac 0.05.
export const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  budget: { maxPodsPerDay: 40, maxConcurrentSandboxes: 5, sandboxTimeoutMin: 10, exaCallsPerPod: 10, dailySpendCapUsd: 50 },
  models: {},
  limits: {
    perTradeUsd: 50, perTradePct: 0.05, perMarket: 100, perEvent: 100, perCategory: 300, totalOpen: 500, dailyNotional: 500, dailyLoss: 100,
    categoryThreshold: 0.3,
    l3: { perTradeUsd: 25, dailyNotional: 150, categoryAllowlist: [], structuralAuto: false },
  },
  overrides: {},
};

const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Objects merge key by key; arrays and scalars replace. `overrides`/`models` are open maps, so patch keys win. */
const merge = (base: any, patch: any): any =>
  plain(base) && plain(patch) ? { ...base, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, merge(base[k], v)])) } : (patch ?? base);

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = (await db.select().from(s.settings).limit(1))[0];
  return AppSettingsSchema.parse(merge(DEFAULT_APP_SETTINGS, row?.data)) as AppSettings;
}

/** Deep-merges `patch` onto the stored settings, validates, saves. Throws ZodError on bad input (nothing saved). */
export async function putSettings(db: Db, patch: unknown): Promise<AppSettings> {
  const next = AppSettingsSchema.parse(merge(await getSettings(db), patch)) as AppSettings;
  await db.insert(s.settings).values({ id: 1, data: next }).onConflictDoUpdate({ target: s.settings.id, set: { data: next } });
  return next;
}

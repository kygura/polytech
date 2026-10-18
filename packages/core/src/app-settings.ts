import { z } from "zod";
import { MODES } from "./book/types";
import { DEFAULT_SETTINGS, type Settings } from "./types";

const num = z.number().finite();
const nonneg = num.min(0);
const mode = z.enum(MODES);

export const AppSettingsSchema = z.strictObject({
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
    totalOpen: nonneg, dailyNotional: nonneg, dailyLoss: nonneg, // dailyLoss 0 = auto-downgrade disabled
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

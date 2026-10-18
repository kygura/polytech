import { z } from "zod";

/** Built-in pod roles. Mirrors ROLES in @pm/agents/pod.ts (core can't import agents: agents depends on core). */
export const BUILTIN_ROLES = ["rules", "source", "base_rate", "news", "red_team"] as const;
export type RoleKey = (typeof BUILTIN_ROLES)[number];
/** Models an operator may pick. Superset of DEFAULT_MODELS values in @pm/agents/router.ts (a web test keeps them in sync). */
export const ALLOWED_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

const nonneg = z.number().finite().min(0);
const day = z.number().finite().min(0);

export const ProfileFilterSchema = z.strictObject({
  categories: z.array(z.string()).optional(),
  tagsAny: z.array(z.string()).optional(),
  textQuery: z.string().optional(),
  minVol24h: nonneg.optional(),
  minDepthUsd: nonneg.optional(),
  maxSpread: nonneg.optional(),
  endsWithinDays: z.strictObject({ min: day.optional(), max: day.optional() }).optional(),
  minAbsEdge: nonneg.optional(),
  skipIfResearchedWithinHours: nonneg.default(24),
  includeConditionIds: z.array(z.string()).optional(),
  excludeConditionIds: z.array(z.string()).optional(),
  sort: z.enum(["vol24h", "edge", "endDate", "priority"]).default("priority"),
  limit: z.number().int().min(1).max(50).default(10),
});
export type ProfileFilter = z.infer<typeof ProfileFilterSchema>;

const roleKey = z.string().regex(/^[a-z][a-z0-9_]{1,23}$/);
const builtin = z.enum(BUILTIN_ROLES);
const model = z.enum(ALLOWED_MODELS);

/** Unrefined shape: use `.partial()` on this for ad-hoc overrides (refined schemas can't be partialed). */
export const SteeringShape = z.strictObject({
  question: z.string().max(2000).optional(),
  roles: z.array(builtin).min(1),
  customRoles: z.array(z.strictObject({ key: roleKey, prompt: z.string().min(1).max(4000) })).max(5).default([]),
  models: z.record(z.string(), model).default({}),
  maxCostUsd: nonneg.optional(),
  exaCallCap: z.number().int().min(0).optional(),
  maxTurns: z.number().int().min(1).optional(),
});

/** Cross-field rules, also applied to a merged (default + override) steering. */
export const SteeringSchema = SteeringShape.superRefine((v, ctx) => {
  const keys = [...v.roles, ...v.customRoles.map((r) => r.key)];
  const bad = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  if (new Set(keys).size !== keys.length) bad("duplicate role key", ["customRoles"]);
  v.customRoles.forEach((r, i) => [...BUILTIN_ROLES, "judge"].includes(r.key) && bad("collides with a built-in role", ["customRoles", i, "key"]));
  if (keys.length > 10) bad("at most 10 roles in total", ["roles"]);
  for (const k of Object.keys(v.models)) if (k !== "judge" && !keys.includes(k)) bad(`model for unknown role "${k}"`, ["models", k]);
});
export type Steering = z.infer<typeof SteeringSchema>;

/** Today's behavior: all five built-in roles, no question, default models. */
export const DEFAULT_STEERING: Steering = { roles: [...BUILTIN_ROLES], customRoles: [], models: {} };

export const ProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(false),
  filter: ProfileFilterSchema.default(() => ProfileFilterSchema.parse({})),
  steering: SteeringSchema.default(DEFAULT_STEERING),
  everyMin: z.number().int().min(1).nullable().default(null),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export type ResearchProfile = ProfileInput & { id: string; lastRunAt: Date | null; createdAt: Date; updatedAt: Date };

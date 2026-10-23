import type { ALLOWED_MODELS } from "@pm/core";

export type ModelRole = "rules" | "source" | "base_rate" | "news" | "red_team" | "judge" | "r_classifier" | "triage";

export const DEFAULT_MODELS: Record<ModelRole, (typeof ALLOWED_MODELS)[number]> = {
  rules: "claude-sonnet-5-5", // resolving the rules needs a capable reader, not maximum reasoning
  source: "claude-sonnet-5-5",
  base_rate: "claude-sonnet-5-5",
  news: "claude-sonnet-5-5",
  red_team: "claude-sonnet-5-5",
  judge: "claude-opus-5-5",
  r_classifier: "claude-haiku-5-5",
  triage: "claude-haiku-5-5",
};

/** role -> model id; `models` is the Settings override map. Custom role keys fall back to the source model. */
export const modelFor = (role: string, models?: Partial<Record<string, string>>) =>
  models?.[role] ?? (DEFAULT_MODELS as Record<string, string>)[role] ?? DEFAULT_MODELS.source;

// ponytail: placeholder USD per Mtok (in/out) to cost judge + classifier calls; replace with real pricing.
const PRICE: [string, number, number][] = [["haiku", 1, 5], ["sonnet", 3, 15], ["opus", 5, 25]];
export const costUsd = (model: string, inTok: number, outTok: number) => {
  const [, i, o] = PRICE.find(([k]) => model.includes(k)) ?? PRICE[1]!;
  return (inTok * i + outTok * o) / 1e6;
};

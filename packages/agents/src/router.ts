export type ModelRole = "rules" | "source" | "base_rate" | "news" | "red_team" | "judge" | "r_classifier";

export const DEFAULT_MODELS: Record<ModelRole, string> = {
  rules: "claude-haiku-5-5",
  source: "claude-sonnet-5-5",
  base_rate: "claude-sonnet-5-5",
  news: "claude-sonnet-5-5",
  red_team: "claude-sonnet-5-5",
  judge: "claude-opus-5-5",
  r_classifier: "claude-haiku-5-5",
};

/** role -> model id; `models` is the Settings override map. */
export const modelFor = (role: ModelRole, models?: Partial<Record<ModelRole, string>>) =>
  models?.[role] ?? DEFAULT_MODELS[role];

// ponytail: placeholder USD per Mtok (in/out) to cost judge + classifier calls; replace with real pricing.
const PRICE: [string, number, number][] = [["haiku", 1, 5], ["sonnet", 3, 15], ["opus", 5, 25]];
export const costUsd = (model: string, inTok: number, outTok: number) => {
  const [, i, o] = PRICE.find(([k]) => model.includes(k)) ?? PRICE[1]!;
  return (inTok * i + outTok * o) / 1e6;
};

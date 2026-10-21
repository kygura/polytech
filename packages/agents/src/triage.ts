import { z } from "zod";
import { withBackoff } from "./backoff";
import type { Client } from "./classify";
import { TRIAGE_PROMPT } from "./prompts";
import { costUsd, modelFor } from "./router";
import { clamp01, jsonSchema } from "./schema";
import type { Usage } from "./runner";

export const TriageOut = z.object({ verdict: z.enum(["research", "skip"]), score: z.number(), reason: z.string() });
export type TriageOut = z.infer<typeof TriageOut>;
/** Blind like the agents: question, rules, category and time left; never the price. */
export type TriageInput = { question: string; rules: string; category: string; daysLeft: number };
export type Triage = (i: TriageInput) => Promise<TriageOut & { model: string | null; usage: Usage }>;

/** No key: the rules-text cue score decides (same cues as the screen's heuristic R). `heuristic` maps rules text to 0..1. */
export const heuristicTriage = (heuristic: (rules: string) => number): Triage => async ({ rules }) => {
  const score = heuristic(rules);
  return { verdict: score >= 0.5 ? "research" : "skip", score, reason: score >= 0.5 ? "Rules name an objective source or a dated event." : "Rules give no clear objective source.", model: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
};

/** One cheap Haiku call per market. Thinking off (Haiku only accepts that), low effort: this is a sort, not research. */
export const anthropicTriage = (client: Client, model = modelFor("triage")): Triage => async (i) => {
  const msg = await withBackoff(() =>
    client.messages.create({
      model,
      max_tokens: 1000,
      ...(model.includes("haiku") ? { thinking: { type: "disabled" as const } } : {}),
      system: [{ type: "text", text: TRIAGE_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify({ question: i.question, category: i.category, days_left: Math.round(i.daysLeft), rules: i.rules.slice(0, 6000) }) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: jsonSchema(TriageOut) } },
    }, { timeout: 20_000, maxRetries: 0 }),
  );
  const block = msg.content.find((b) => b.type === "text");
  const r = TriageOut.parse(JSON.parse(block && "text" in block ? block.text : "{}"));
  const u = msg.usage;
  return { ...r, score: clamp01(r.score), reason: r.reason.slice(0, 200), model, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: costUsd(model, u.input_tokens, u.output_tokens) } };
};

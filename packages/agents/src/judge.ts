import { z } from "zod";
import type { AgentOutput } from "@pm/core";
import { withBackoff, type BackoffOpts } from "./backoff";
import type { Client } from "./classify";
import { JUDGE_PROMPT, focusLine, type Brief } from "./prompts";
import { costUsd, modelFor } from "./router";
import { clamp01, jsonSchema } from "./schema";
import type { Usage } from "./runner";

export const JudgeOut = z.object({
  p_hat: z.number(),
  confidence: z.number(),
  thesis: z.string(),
  catalysts: z.array(z.object({ date: z.string(), label: z.string() })),
  kill_criteria: z.array(z.string()),
  /** The facts the verdict rests on, taken from the analysts' key_facts (same url), each graded on its source and its claim. */
  key_evidence: z.array(z.object({
    url: z.string(),
    claim: z.string(),
    reputation: z.enum(["high", "medium", "low"]),
    claim_strength: z.enum(["verified", "partial", "weak"]),
    why: z.string(),
  })),
});
export type JudgeOut = z.infer<typeof JudgeOut>;

export type BookSummary = { pMid: number; bestBid: number | null; bestAsk: number | null; bidDepthUsd: number; askDepthUsd: number };
export type JudgeInput = { brief: Brief; outputs: AgentOutput[]; book: BookSummary; model?: string; deadline?: number; signal?: AbortSignal /* abort => the request stops */ };
export type Judge = (i: JudgeInput) => Promise<{ judge: JudgeOut; usage: Usage }>;

export const fakeJudge: Judge = async ({ outputs }) => {
  const ps = outputs.map((o) => o.probability).filter((p): p is number => p != null);
  return {
    judge: {
      p_hat: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.5,
      confidence: 0.6,
      thesis: "Fake judge: mean of agent probabilities.",
      catalysts: [],
      kill_criteria: [],
      key_evidence: [],
    },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
};

/** Price is revealed only here: agent results first, book last. */
export const anthropicJudge =
  (client: Client, model = modelFor("judge"), backoff?: BackoffOpts): Judge =>
  async ({ brief, outputs, book, model: m, deadline, signal }) => {
    const useModel = m ?? model;
    const msg = await withBackoff(
      () =>
        client.messages.create({
          model: useModel,
          max_tokens: 16_000, // thinking shares this budget: 2k truncated the JSON
          system: [{ type: "text", text: JUDGE_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: `Question: ${brief.question}${focusLine(brief)}\n\nAGENT RESULTS:\n${JSON.stringify(outputs)}\n\nCURRENT BOOK:\n${JSON.stringify(book)}`,
            },
          ],
          output_config: { effort: "high", format: { type: "json_schema", schema: jsonSchema(JudgeOut) } },
        }, { signal }),
      { ...backoff, deadline },
    );
    const block = msg.content.find((b) => b.type === "text");
    const j = JudgeOut.parse(JSON.parse(block && "text" in block ? block.text : "{}"));
    const inputTokens = msg.usage.input_tokens, outputTokens = msg.usage.output_tokens;
    return {
      judge: { ...j, p_hat: clamp01(j.p_hat), confidence: clamp01(j.confidence) },
      usage: { inputTokens, outputTokens, costUsd: costUsd(useModel, inputTokens, outputTokens) },
    };
  };

/** Prod without ANTHROPIC_API_KEY: never fabricate a thesis. */
export const disabledJudge: Judge = async () => {
  throw new Error("RESEARCH_DISABLED: ANTHROPIC_API_KEY unset in production");
};

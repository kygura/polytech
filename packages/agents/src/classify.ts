import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { withBackoff, type BackoffOpts } from "./backoff";
import { R_PROMPT } from "./prompts";
import { clamp01, jsonSchema } from "./schema";
import { modelFor } from "./router";

export const RResult = z.object({
  R: z.number(),
  objective_source: z.boolean(),
  scheduled_event: z.boolean(),
  public_data_release: z.boolean(),
  rule_ambiguity: z.number(),
  note: z.string(),
});
export type RResult = z.infer<typeof RResult>;

/** Cache key: re-classify only when rules text changes. */
export const rulesHash = (rules: string) => createHash("sha256").update(rules.trim()).digest("hex");

export type Client = Pick<Anthropic, "messages">;

export async function classifyR(rulesText: string, client: Client, model = modelFor("r_classifier"), backoff?: BackoffOpts): Promise<RResult> {
  const msg = await withBackoff(
    () =>
      client.messages.create({
        model,
        max_tokens: 400,
        system: [{ type: "text", text: R_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: rulesText }],
        output_config: { format: { type: "json_schema", schema: jsonSchema(RResult) } },
      }),
    backoff,
  );
  const block = msg.content.find((b) => b.type === "text");
  const r = RResult.parse(JSON.parse(block && "text" in block ? block.text : "{}"));
  return { ...r, R: clamp01(r.R), rule_ambiguity: clamp01(r.rule_ambiguity) };
}

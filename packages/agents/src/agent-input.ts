import { AgentOutput } from "@pm/core";
import type { AgentInput } from "./agent-query.mjs";
import { ROLE_PROMPTS, userPrompt, type AgentRole, type Brief } from "./prompts";
import type { RunOpts } from "./runner";
import { jsonSchema } from "./schema";

const SCHEMA = jsonSchema(AgentOutput);

export const agentInput = (role: AgentRole, brief: Brief, o: RunOpts, exaKey: string): AgentInput => ({
  system: ROLE_PROMPTS[role],
  prompt: userPrompt(brief) + (o.hint ? `\n\n${o.hint}` : ""),
  schema: SCHEMA,
  model: o.model,
  exaCallCap: o.exaCallCap,
  exaKey,
  timeoutMs: o.timeoutMs,
});

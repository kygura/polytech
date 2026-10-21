import type Anthropic from "@anthropic-ai/sdk";
import { AgentOutput, type RoleKey } from "@pm/core";
import { withBackoff } from "./backoff";
import type { Client } from "./classify";
import { ROLE_PROMPTS, userPrompt } from "./prompts";
import { costUsd } from "./router";
import { validated, type AgentRunner, type ToolCall } from "./runner";
import { jsonSchema } from "./schema";

const SCHEMA = jsonSchema(AgentOutput) as Anthropic.Tool.InputSchema;
const SUBMIT = "submit_result";
const MAX_TOOL_CALLS = 200;
const SEARCH_USD = 0.01; // web search is billed per request ($10 / 1000) on top of tokens
const NUDGES = 2; // turns that ended without submit_result before the agent gives up

/** Haiku is the rules reader: a light pass. Sonnet/Opus agents research at medium effort to fit the pod's agent window. */
const effortFor = (model: string): "low" | "medium" => (model.includes("haiku") ? "low" : "medium");

/**
 * One research agent on the plain Messages API: Anthropic-hosted web search + web fetch, then a strict `submit_result` call carrying the
 * structured output. No subprocess and no sandbox, so it runs inside a Vercel function (the Agent SDK's native CLI binary does not ship there).
 */
export const apiRunner = (client: Client): AgentRunner =>
  validated(async (role, brief, opts) => {
    const t = Date.now();
    const ac = new AbortController();
    const stop = () => ac.abort();
    const timer = setTimeout(stop, opts.timeoutMs);
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener("abort", stop, { once: true });

    const tools: Anthropic.ToolUnion[] = [
      { type: "web_search_20260209", name: "web_search", max_uses: opts.exaCallCap },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: opts.exaCallCap },
      { name: SUBMIT, description: "Submit your final structured result. Call it exactly once, when your research is done.", input_schema: SCHEMA, strict: true },
    ];
    const system = `${opts.system ?? ROLE_PROMPTS[role as RoleKey]}\n\nUse web_search and web_fetch for sources. When done, call ${SUBMIT} once with the result; never write the result as plain text.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt(brief) + (opts.hint ? `\n\n${opts.hint}` : "") }];
    const toolCalls: ToolCall[] = [], byId = new Map<string, ToolCall>();
    let inTok = 0, outTok = 0, searches = 0, nudges = 0;

    try {
      for (let turn = 0; turn < (opts.maxTurns ?? 20); turn++) {
        const msg = await withBackoff(
          () => client.messages.stream({
            model: opts.model,
            max_tokens: 32_000,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools,
            tool_choice: { type: "auto" },
            output_config: { effort: effortFor(opts.model) },
            messages,
          }, { signal: ac.signal }).finalMessage(),
          { deadline: opts.deadline },
        );
        inTok += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
        outTok += msg.usage.output_tokens;
        searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
        for (const b of msg.content) {
          if (b.type === "server_tool_use" && toolCalls.length < MAX_TOOL_CALLS) {
            const c: ToolCall = { ts: Date.now(), name: b.name, input: (JSON.stringify(b.input ?? {}) ?? "").slice(0, 500), ok: true };
            toolCalls.push(c);
            byId.set(b.id, c);
          } else if ((b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") && !Array.isArray(b.content) && "error_code" in b.content) {
            const c = byId.get(b.tool_use_id);
            if (c) c.ok = false;
          }
        }
        const usage = () => ({ inputTokens: inTok, outputTokens: outTok, costUsd: costUsd(opts.model, inTok, outTok) + searches * SEARCH_USD });
        const submit = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT);
        if (submit) return { output: submit.input, usage: usage(), toolCalls, durationS: (Date.now() - t) / 1000, sandboxS: 0 };
        if (msg.stop_reason === "refusal") throw new Error(`agent ${role} refused: ${msg.stop_details?.category ?? "no category"}`);
        if (msg.stop_reason === "max_tokens") throw new Error(`agent ${role} hit max_tokens before submitting`);
        messages.push({ role: "assistant", content: msg.content });
        // pause_turn: the server-side tool loop hit its iteration cap; re-sending the assistant turn resumes it (no extra user message)
        if (msg.stop_reason === "pause_turn") continue;
        if (++nudges > NUDGES) throw new Error(`agent ${role} never called ${SUBMIT}`);
        messages.push({ role: "user", content: `Call ${SUBMIT} now with your final result.` });
      }
      throw new Error(`agent ${role} ran out of turns`);
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      if (ac.signal.aborted) throw new Error(`TIMEOUT: agent ${role} exceeded ${Math.round(opts.timeoutMs / 1000)}s`);
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
    }
  });

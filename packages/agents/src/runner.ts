import { createHash } from "node:crypto";
import { AgentOutput } from "@pm/core";
import { withBackoff, type BackoffOpts } from "./backoff";
import type { AgentRole, Brief } from "./prompts";

/** `system` overrides ROLE_PROMPTS[role] (custom roles); `maxTurns` bounds the agent loop. */
export type RunOpts = { model: string; timeoutMs: number; exaCallCap: number; hint?: string; system?: string; maxTurns?: number; deadline?: number /* epoch ms: no attempt starts or runs past it */; signal?: AbortSignal /* abort => the run stops and rejects */ };
/** One tool invocation by an agent: `input` is JSON text (<= 500 chars), `ok` false when the matching tool_result was an error. Runners return at most 200. */
export type ToolCall = { ts: number; name: string; input: string; ok: boolean };
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };
export type Run = { output: AgentOutput; usage: Usage; durationS: number; sandboxS: number; toolCalls?: ToolCall[] };
export type AgentRunner = (role: AgentRole, brief: Brief, opts: RunOpts) => Promise<Run>;
/** Implementations return unvalidated output; `validated` parses, retries once, backs off. */
export type RawRunner = (role: AgentRole, brief: Brief, opts: RunOpts) => Promise<Omit<Run, "output"> & { output: unknown }>;

export const validated =
  (raw: RawRunner, backoff?: BackoffOpts): AgentRunner =>
  async (role, brief, opts) => {
    let hint = opts.hint;
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const left = (opts.deadline ?? Infinity) - Date.now();
      if (left <= 0) throw new Error("TIMEOUT: deadline reached before attempt");
      const r = await withBackoff(() => raw(role, brief, { ...opts, hint, timeoutMs: Math.min(opts.timeoutMs, left) }), { ...backoff, deadline: opts.deadline });
      const p = AgentOutput.safeParse(r.output);
      if (p.success && p.data.role === role) return { ...r, output: p.data };
      const why = p.success ? `role must be "${role}"` : p.error.message;
      if (attempt >= 1) throw new Error(`agent ${role} failed schema validation: ${why}`);
      hint = `Your previous output was invalid: ${why}\nReturn a corrected result.`;
    }
  };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const onAbort = () => { clearTimeout(t); rej(new Error("cancelled")); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** PM_FAKE_AGENT_MS slows the fake runner so the Runs view has something to show and cancel (default: instant). */
export const fakeRaw: RawRunner = async (role, brief, opts) => {
  const delay = Number(process.env.PM_FAKE_AGENT_MS) || 0;
  if (delay) await sleep(delay, opts?.signal);
  const h = createHash("sha256").update(role + JSON.stringify(brief)).digest();
  const today = new Date().toISOString().slice(0, 10);
  const hex = h.toString("hex").slice(0, 8);
  const n = 1 + (h[1]! % 3);
  return {
    output: {
      role,
      probability: role === "rules" ? null : 0.05 + 0.9 * (h[0]! / 255),
      confidence: 0.3 + 0.5 * (h[2]! / 255),
      key_facts: Array.from({ length: n }, (_, i) => ({
        claim: `Example ${role} fact ${i + 1}`,
        url: `https://example.com/${role}/${hex}/${i + 1}`,
        quote: `Example quote ${i + 1} supporting the ${role} finding`,
        date: today,
      })),
      risks: ["fake runner output"],
      notes: `Deterministic fake ${role} result.`,
    },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    durationS: 0,
    sandboxS: 0,
    toolCalls: role === "rules" ? [] : [
      { ts: Date.now(), name: "mcp__exa__search", input: JSON.stringify({ query: `${brief.question} ${role}`.slice(0, 120), numResults: 5 }), ok: true },
      { ts: Date.now(), name: "mcp__exa__contents", input: JSON.stringify({ urls: [`https://example.com/${role}/${hex}/1`] }), ok: true },
    ],
  };
};
export const fakeRunner = validated(fakeRaw);

type Env = Record<string, string | undefined>;
export const hasSandboxCreds = (e: Env) => !!(e.VERCEL_OIDC_TOKEN || (e.VERCEL_TOKEN && e.VERCEL_TEAM_ID && e.VERCEL_PROJECT_ID));

export const isProd = (e: Env) => e.VERCEL_ENV === "production" || e.NODE_ENV === "production";

/** Sentinel: prod without a key. Callers compare identity and skip research instead of storing fake results. */
export const disabledRunner: AgentRunner = async () => {
  throw new Error("research disabled: ANTHROPIC_API_KEY unset in production");
};

export type RunnerKind = "api" | "sandbox" | "local" | "fake" | "disabled";

/**
 * Key -> Messages API runner (Anthropic-hosted web search/fetch; works inside serverless functions). PM_RUNNER=sandbox (needs Vercel creds)
 * or PM_RUNNER=agent-sdk opts into the Agent SDK runners. No key -> fake only if PM_FIXTURES=1 or not prod, else disabled.
 * Lazy imports keep SDKs out of fake/test paths.
 */
export async function pickRunner(env: Env = process.env): Promise<{ kind: RunnerKind; runner: AgentRunner }> {
  if (!env.ANTHROPIC_API_KEY) return env.PM_FIXTURES === "1" || !isProd(env) ? { kind: "fake", runner: fakeRunner } : { kind: "disabled", runner: disabledRunner };
  if (env.PM_RUNNER === "sandbox" && hasSandboxCreds(env)) return { kind: "sandbox", runner: (await import("./sandbox")).sandboxRunner(env) };
  if (env.PM_RUNNER === "agent-sdk") return { kind: "local", runner: (await import("./local")).localRunner(env) };
  const [{ apiRunner }, { default: Anthropic }] = await Promise.all([import("./api"), import("@anthropic-ai/sdk")]);
  return { kind: "api", runner: apiRunner(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 })) };
}

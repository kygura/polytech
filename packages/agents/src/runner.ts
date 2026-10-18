import { createHash } from "node:crypto";
import { AgentOutput } from "@pm/core";
import { withBackoff, type BackoffOpts } from "./backoff";
import type { AgentRole, Brief } from "./prompts";

export type RunOpts = { model: string; timeoutMs: number; exaCallCap: number; hint?: string };
export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };
export type Run = { output: AgentOutput; usage: Usage; durationS: number; sandboxS: number };
export type AgentRunner = (role: AgentRole, brief: Brief, opts: RunOpts) => Promise<Run>;
/** Implementations return unvalidated output; `validated` parses, retries once, backs off. */
export type RawRunner = (role: AgentRole, brief: Brief, opts: RunOpts) => Promise<Omit<Run, "output"> & { output: unknown }>;

export const validated =
  (raw: RawRunner, backoff?: BackoffOpts): AgentRunner =>
  async (role, brief, opts) => {
    let hint = opts.hint;
    for (let attempt = 0; ; attempt++) {
      const r = await withBackoff(() => raw(role, brief, { ...opts, hint }), backoff);
      const p = AgentOutput.safeParse(r.output);
      if (p.success && p.data.role === role) return { ...r, output: p.data };
      const why = p.success ? `role must be "${role}"` : p.error.message;
      if (attempt >= 1) throw new Error(`agent ${role} failed schema validation: ${why}`);
      hint = `Your previous output was invalid: ${why}\nReturn a corrected result.`;
    }
  };

export const fakeRaw: RawRunner = async (role, brief) => {
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

/** key + Vercel creds -> sandbox; key only -> local; no key -> fake only if PM_FIXTURES=1 or not prod, else disabled. Lazy imports keep SDKs out of fake/test paths. */
export async function pickRunner(env: Env = process.env): Promise<{ kind: "sandbox" | "local" | "fake" | "disabled"; runner: AgentRunner }> {
  if (!env.ANTHROPIC_API_KEY) return env.PM_FIXTURES === "1" || !isProd(env) ? { kind: "fake", runner: fakeRunner } : { kind: "disabled", runner: disabledRunner };
  if (hasSandboxCreds(env)) return { kind: "sandbox", runner: (await import("./sandbox")).sandboxRunner(env) };
  return { kind: "local", runner: (await import("./local")).localRunner(env) };
}

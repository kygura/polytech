import { runAgent } from "./agent-query.mjs";
import { agentInput } from "./agent-input";
import { validated, type AgentRunner } from "./runner";

/** Dev: same Agent SDK query, in-process. Needs ANTHROPIC_API_KEY (+ EXA_API_KEY for search). */
export const localRunner = (env: Record<string, string | undefined> = process.env): AgentRunner =>
  validated(async (role, brief, opts) => {
    const t = Date.now();
    const r = await runAgent({ ...agentInput(role, brief, opts, env.EXA_API_KEY ?? ""), signal: opts.signal });
    return { ...r, durationS: (Date.now() - t) / 1000, sandboxS: 0 };
  });

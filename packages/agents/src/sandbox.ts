import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";
import { agentInput } from "./agent-input";
import { AnthropicOutageError, isOverloadText } from "./backoff";
import { validated, type AgentRunner } from "./runner";

const MAIN = `import { readFileSync } from "node:fs";
import { runAgent } from "./agent-query.mjs";
const r = await runAgent(JSON.parse(readFileSync("input.json", "utf8")));
console.log("__RESULT__" + JSON.stringify(r));
`;
const PKG = JSON.stringify({ type: "module", dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.300", zod: "^4.6.7" } });
const query = readFile(new URL("./agent-query.mjs", import.meta.url));

/** One Vercel Sandbox per agent. Only ANTHROPIC_API_KEY + EXA_API_KEY enter the sandbox. */
export const sandboxRunner = (env: Record<string, string | undefined> = process.env): AgentRunner =>
  validated(async (role, brief, opts) => {
    const t = Date.now();
    const sandbox = await Sandbox.create({
      image: "vercel/sandbox/node:24",
      timeout: opts.timeoutMs + 120_000,
      ...(env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID
        ? { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID }
        : {}),
    });
    try {
      await sandbox.writeFiles([
        { path: "package.json", content: Buffer.from(PKG) },
        { path: "agent-query.mjs", content: await query },
        { path: "main.mjs", content: Buffer.from(MAIN) },
        { path: "input.json", content: Buffer.from(JSON.stringify(agentInput(role, brief, opts, ""))) },
      ]);
      const inst = await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund"] });
      if (inst.exitCode !== 0) throw new Error(`sandbox npm install failed: ${await inst.stderr()}`);
      const run = await sandbox.runCommand({ cmd: "node", args: ["main.mjs"], env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "", EXA_API_KEY: env.EXA_API_KEY ?? "" } });
      const out = await run.stdout();
      if (run.exitCode !== 0) {
        const err = (await run.stderr()).slice(-500);
        throw isOverloadText(err) ? new AnthropicOutageError(1, err) : new Error(`sandbox agent failed: ${err}`);
      }
      const line = out.split("\n").reverse().find((l) => l.startsWith("__RESULT__"));
      if (!line) throw new Error("sandbox agent printed no result");
      const secs = (Date.now() - t) / 1000;
      return { ...JSON.parse(line.slice(10)), durationS: secs, sandboxS: secs };
    } finally {
      await sandbox.stop().catch(() => {});
    }
  });

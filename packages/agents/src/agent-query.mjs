// Single source of truth for one research agent. Run in-process (localRunner) or
// copied verbatim into a Vercel Sandbox (sandboxRunner). Plain ESM: the sandbox has no TS toolchain.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const BUILTIN = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "Task"];

/** input: {system, prompt, schema, model, exaCallCap, exaKey, timeoutMs, maxTurns?} */
export async function runAgent(input) {
  let calls = 0;
  const exa = async (path, body) => {
    if (++calls > input.exaCallCap) return { content: [{ type: "text", text: "Exa call cap reached" }], isError: true };
    const res = await fetch("https://api.exa.ai" + path, {
      method: "POST",
      headers: { "x-api-key": input.exaKey || process.env.EXA_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { content: [{ type: "text", text: `Exa HTTP ${res.status}` }], isError: true };
    const retrieved_at = new Date().toISOString();
    const j = await res.json();
    const results = (j.results ?? []).map((r) => ({ url: r.url, title: r.title, published: r.publishedDate, text: r.text, retrieved_at }));
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  };
  const search = tool("search", "Web search via Exa; returns url, title, published date, text, retrieved_at.", { query: z.string(), numResults: z.number().optional() }, ({ query: q, numResults }) =>
    exa("/search", { query: q, numResults: numResults ?? 5, contents: { text: { maxCharacters: 3000 } } }));
  const contents = tool("contents", "Fetch page text for urls via Exa.", { urls: z.array(z.string()) }, ({ urls }) =>
    exa("/contents", { urls, text: { maxCharacters: 6000 } }));
  const server = createSdkMcpServer({ name: "exa", version: "1.0.0", tools: [search, contents] });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), input.timeoutMs);
  let last;
  try {
    for await (const msg of query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.system,
        mcpServers: { exa: server },
        allowedTools: ["mcp__exa__search", "mcp__exa__contents"],
        disallowedTools: BUILTIN,
        maxTurns: input.maxTurns ?? 20,
        outputFormat: { type: "json_schema", schema: input.schema },
        abortController: ac,
        env: { ...process.env },
      },
    })) if (msg.type === "result") last = msg;
  } finally {
    clearTimeout(timer);
  }
  if (!last || last.subtype !== "success") throw new Error(`agent failed: ${last?.subtype ?? "no result"}`);
  const mu = Object.values(last.modelUsage ?? {});
  const sum = (k) => mu.reduce((a, m) => a + (m[k] ?? 0), 0);
  return {
    output: last.structured_output,
    usage: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costUsd: last.total_cost_usd ?? sum("costUSD") },
  };
}

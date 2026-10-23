// Single source of truth for one research agent. Run in-process (localRunner) or
// copied verbatim into a Vercel Sandbox (sandboxRunner). Plain ESM: the sandbox has no TS toolchain.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchUrlText } from "./safe-fetch.mjs";

const BUILTIN = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "Task"];
const WEB = ["WebSearch"]; // fallback when no Exa key. WebFetch stays disallowed: fetch_url replaces it (SSRF-guarded)
const MAX_TOOL_CALLS = 200;

/** input: {system, prompt, schema, model, exaCallCap, exaKey, timeoutMs, maxTurns?, signal?}. Returns {output, usage, toolCalls, pages}. */
export async function runAgent(input) {
  let calls = 0;
  // text the agent actually read, for the quote check (core quote.ts); bounded like runner.ts PAGE_CHARS / MAX_PAGES
  const pages = [];
  const read = (url, text) => { if (pages.length < 60 && typeof url === "string" && typeof text === "string" && text) pages.push({ url, text: text.slice(0, 20000) }); };
  const ac = new AbortController();
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
    for (const r of results) read(r.url, r.text);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  };
  const search = tool("search", "Web search via Exa; returns url, title, published date, text, retrieved_at.", { query: z.string(), numResults: z.number().optional() }, ({ query: q, numResults }) =>
    exa("/search", { query: q, numResults: numResults ?? 5, contents: { text: { maxCharacters: 3000 } } }));
  const contents = tool("contents", "Fetch page text for urls via Exa.", { urls: z.array(z.string()) }, ({ urls }) =>
    exa("/contents", { urls, text: { maxCharacters: 6000 } }));
  const server = createSdkMcpServer({ name: "exa", version: "1.0.0", tools: [search, contents] });
  let fetches = 0;
  const fetchUrl = tool("fetch_url", "Fetch a public http(s) web page and return its text, wrapped in <untrusted_content>. Private and internal addresses are refused.", { url: z.string() }, async ({ url }) => {
    if (++fetches > input.exaCallCap) return { content: [{ type: "text", text: "fetch_url call cap reached" }], isError: true };
    try {
      const text = await fetchUrlText(url, { signal: ac.signal });
      read(url, text);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `fetch_url failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });
  const web = createSdkMcpServer({ name: "web", version: "1.0.0", tools: [fetchUrl] });

  const useExa = !!(input.exaKey || process.env.EXA_API_KEY);
  const timer = setTimeout(() => ac.abort(), input.timeoutMs);
  const onAbort = () => ac.abort();
  if (input.signal?.aborted) ac.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  // tool_use blocks from assistant messages, ok from the matching tool_result's is_error
  const toolCalls = [], byId = new Map();
  let last;
  try {
    for await (const msg of query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.system,
        mcpServers: useExa ? { exa: server } : { web },
        allowedTools: useExa ? ["mcp__exa__search", "mcp__exa__contents"] : [...WEB, "mcp__web__fetch_url"],
        // base_rate scripts need key isolation + egress allowlist (phase 6)
        disallowedTools: useExa ? BUILTIN : BUILTIN.filter((t) => !WEB.includes(t)),
        maxTurns: input.maxTurns ?? 20,
        outputFormat: { type: "json_schema", schema: input.schema },
        abortController: ac,
        // allowlist: this subprocess reads untrusted web content
        env: Object.fromEntries(["PATH", "HOME", "ANTHROPIC_API_KEY", "EXA_API_KEY"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      },
    })) {
      if (msg.type === "result") last = msg;
      else if (msg.type === "assistant" || msg.type === "user") {
        for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (b.type === "tool_use" && toolCalls.length < MAX_TOOL_CALLS) {
            const c = { ts: Date.now(), name: String(b.name), input: (JSON.stringify(b.input ?? {}) ?? "").slice(0, 500), ok: true };
            toolCalls.push(c);
            byId.set(b.id, c);
          } else if (b.type === "tool_result" && b.is_error && byId.has(b.tool_use_id)) byId.get(b.tool_use_id).ok = false;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
  if (input.signal?.aborted) throw new Error("cancelled");
  if (!last || last.subtype !== "success") throw new Error(`agent failed: ${last?.subtype ?? "no result"}`);
  const mu = Object.values(last.modelUsage ?? {});
  const sum = (k) => mu.reduce((a, m) => a + (m[k] ?? 0), 0);
  return {
    output: last.structured_output,
    usage: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costUsd: last.total_cost_usd ?? sum("costUSD") },
    toolCalls,
    pages,
  };
}

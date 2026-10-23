import { describe, expect, it } from "vitest";
import type { Market } from "@pm/core";
import { AgentOutput } from "@pm/core";
import { DEFAULT_STEERING, type Steering } from "@pm/core";
import { AnthropicOutageError, anthropicJudge, apiRunner, userPrompt, isOverloadText, PodFailedError, PodTimeoutError, buildBrief, classifyR, disabledRunner, fakeJudge, fakeRaw, fakeRunner, modelFor, pickRunner, rulesHash, runPod, validated, withBackoff } from "./index";
import type { RawRunner } from "./runner";

const mk = (q: string): Market => ({
  conditionId: q, eventId: "e", question: q, rules: "Resolves YES if X per https://example.com.", category: "politics",
  tags: ["a"], endDate: Date.parse("2026-12-01"), negRiskGroup: null, feeRate: 0.02, open: true, acceptingOrders: true, inDispute: false,
});
const market = mk("Will X happen?");
const sibs = [mk("Will Y happen?")];
const book = { bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.54, size: 100 }], pMid: 0.52 };
const opts = { model: "m", timeoutMs: 1000, exaCallCap: 3 };
const noWait = { baseMs: 0 };

describe("brief", () => {
  it("has no price/book fields", () => {
    const s = JSON.stringify(buildBrief(market, sibs));
    expect(Object.keys(buildBrief(market, sibs)).sort()).toEqual(["end_date", "question", "rules", "siblings", "tags"]);
    expect(s).not.toMatch(/price|mid|book|bid|ask/i);
  });
});

describe("router", () => {
  it("defaults + override", () => {
    expect(modelFor("rules")).toBe("claude-haiku-5-5");
    expect(modelFor("judge")).toBe("claude-opus-5-5");
    expect(modelFor("news", { news: "x" })).toBe("x");
  });
});

describe("fakeRunner", () => {
  it("is deterministic and valid", async () => {
    const a = await fakeRunner("news", buildBrief(market, sibs), opts);
    const b = await fakeRunner("news", buildBrief(market, sibs), opts);
    expect(a.output).toEqual(b.output);
    expect(AgentOutput.safeParse(a.output).success).toBe(true);
    expect(a.output.probability).toBeGreaterThanOrEqual(0.05);
    expect(a.output.probability).toBeLessThanOrEqual(0.95);
    expect((await fakeRunner("rules", buildBrief(market, sibs), opts)).output.probability).toBeNull();
  });
});

describe("runPod", () => {
  it("fake runner + fake judge", async () => {
    const done: string[] = [];
    const r = await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge: fakeJudge, onAgentDone: (a) => done.push(a.role) });
    expect(r.agents.map((a) => a.role)).toEqual(["rules", "source", "base_rate", "news", "red_team"]);
    expect(done).toHaveLength(5);
    expect(r.judge.p_hat).toBeGreaterThan(0);
    expect(r.evidence.length).toBeGreaterThanOrEqual(5);
    expect(r.evidence.every((e) => e.quote.split(/\s+/).length < 25 && ["+", "-"].includes(e.direction))).toBe(true);
  });

  it("quote check: fake fact 1 is on the page its runner read, facts 2-3 were never fetched", async () => {
    const r = await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge: fakeJudge });
    for (const e of r.evidence.filter((x) => x.agent_role !== "rules")) expect(e.quote_check).toBe(e.url.endsWith("/1") ? "found" : "unfetched");
  });

  it("quote check: the rules reader's quotes are checked against the rules text in its brief", async () => {
    const raw: RawRunner = async (role, brief, o) => {
      const r = await fakeRaw(role, brief, o);
      if (role !== "rules") return r;
      const out = r.output as { key_facts: { quote: string }[] };
      return { ...r, output: { ...out, key_facts: [{ ...out.key_facts[0]!, quote: brief.rules.split(/\s+/).slice(0, 6).join(" ") }, { ...out.key_facts[0]!, quote: "words the rules never use" }] } };
    };
    const r = await runPod({ market, siblings: sibs, book, runner: validated(raw), judge: fakeJudge });
    expect(r.evidence.filter((e) => e.agent_role === "rules").map((e) => e.quote_check)).toEqual(["found", "not_found"]);
  });

  it("quote check: a misquote on a page that was read reaches the judge as not_found", async () => {
    const raw: RawRunner = async (role, brief, o) => {
      const r = await fakeRaw(role, brief, o);
      return { ...r, pages: (r.pages ?? []).map((p) => ({ ...p, text: "The page says something else entirely." })) };
    };
    let seen: string[] = [];
    const judge: typeof fakeJudge = async (i) => { seen = i.outputs.filter((x) => x.role !== "rules").flatMap((x) => x.key_facts.filter((f) => f.url.endsWith("/1")).map((f) => f.quote_check)); return fakeJudge(i); };
    await runPod({ market, siblings: sibs, book, runner: validated(raw), judge });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((q) => q === "not_found")).toBe(true);
  });

  it("caps confidence when estimates straddle p_mid", async () => {
    const p = { rules: null, source: 0.9, base_rate: 0.8, news: 0.2, red_team: 0.1 } as Record<string, number | null>;
    const raw: RawRunner = async (role, brief, o) => {
      const r = await fakeRaw(role, brief, o);
      return { ...r, output: { ...(r.output as object), probability: p[role] } };
    };
    const r = await runPod({ market, siblings: sibs, book, runner: validated(raw), judge: fakeJudge });
    expect(r.judge.confidence).toBe(0.5);
    expect(r.judge.capped).toBe(true);
  });

  it("capped means straddle tripped, even if judge confidence is already below the cap", async () => {
    const p = { rules: null, source: 0.9, base_rate: 0.8, news: 0.2, red_team: 0.1 } as Record<string, number | null>;
    const raw: RawRunner = async (role, brief, o) => ({ ...(await fakeRaw(role, brief, o)), output: { ...((await fakeRaw(role, brief, o)).output as object), probability: p[role] } });
    const judge: typeof fakeJudge = async (x) => { const j = await fakeJudge(x); return { ...j, judge: { ...j.judge, confidence: 0.3 } }; };
    const r = await runPod({ market, siblings: sibs, book, runner: validated(raw), judge });
    expect(r.judge.confidence).toBe(0.3);
    expect(r.judge.capped).toBe(true);
  });

  it("judge throw surfaces as PodFailedError carrying the agents", async () => {
    const judge: typeof fakeJudge = async () => { throw new Error("judge boom"); };
    const e = await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge }).catch((x) => x);
    expect(e).toBeInstanceOf(PodFailedError);
    expect(e.agents).toHaveLength(5);
  });

  it("hung agents / judge hit the pod deadline and fail with TIMEOUT instead of hanging", async () => {
    const hang = () => new Promise<never>(() => {});
    const a = await runPod({ market, siblings: sibs, book, runner: hang, judge: fakeJudge, settings: { agentsMs: 30 } }).catch((x) => x);
    expect(a).toBeInstanceOf(PodFailedError);
    expect(a.cause).toBeInstanceOf(PodTimeoutError);
    expect(a.agents.every((x: { ok: boolean; error?: string }) => !x.ok && x.error!.startsWith("TIMEOUT"))).toBe(true);
    const j = await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge: hang, settings: { judgeMs: 30 } }).catch((x) => x);
    expect(j).toBeInstanceOf(PodFailedError);
    expect(j.cause).toBeInstanceOf(PodTimeoutError);
    expect(j.agents).toHaveLength(5);
  });

  it("proceeds with 3 ok, fails with fewer", async () => {
    const failing = (n: number): RawRunner => async (role, brief, o) => {
      if (["source", "news", "red_team"].slice(0, n).includes(role)) throw new Error("boom");
      return fakeRaw(role, brief, o);
    };
    const r = await runPod({ market, siblings: sibs, book, runner: validated(failing(2)), judge: fakeJudge });
    expect(r.agents.filter((a) => !a.ok)).toHaveLength(2);
    await expect(runPod({ market, siblings: sibs, book, runner: validated(failing(3)), judge: fakeJudge })).rejects.toThrow(/pod failed/);
  });
});

describe("runPod steering", () => {
  const steer = (o: Partial<Steering>): Steering => ({ ...DEFAULT_STEERING, ...o });
  const spy = () => {
    const calls: { role: string; brief: Parameters<typeof fakeRunner>[1]; o: Parameters<typeof fakeRunner>[2] }[] = [];
    const runner: typeof fakeRunner = async (role, brief, o) => { calls.push({ role, brief, o }); return fakeRunner(role, brief, o); };
    return { calls, runner };
  };

  it("role subset runs only those roles", async () => {
    const { calls, runner } = spy();
    const r = await runPod({ market, siblings: sibs, book, runner, judge: fakeJudge, steering: steer({ roles: ["rules", "news", "source"] }) });
    expect(calls.map((c) => c.role).sort()).toEqual(["news", "rules", "source"]);
    expect(r.agents.map((a) => a.role)).toEqual(["rules", "news", "source"]);
  });

  it("custom role runs with COMMON + operator prompt and a valid output keyed by its role", async () => {
    const seen: string[] = [];
    const runner = validated(async (role, brief, o) => { seen.push(`${role}:${o.system ?? ""}`); return fakeRaw(role, brief, o); });
    const r = await runPod({
      market, siblings: sibs, book, runner, judge: fakeJudge,
      steering: steer({ roles: ["rules", "source", "news"], customRoles: [{ key: "macro", prompt: "Cover macro drivers only." }] }),
    });
    const macro = seen.find((x) => x.startsWith("macro:"))!;
    expect(macro).toMatch(/forecasting pod/);
    expect(macro).toMatch(/Cover macro drivers only\./);
    expect(seen.filter((x) => !x.startsWith("macro:")).every((x) => x.endsWith(":"))).toBe(true); // built-ins keep ROLE_PROMPTS
    expect(r.agents.map((a) => a.role)).toEqual(["rules", "source", "news", "macro"]);
    expect(r.agents.every((a) => a.ok)).toBe(true);
  });

  it("question reaches every agent prompt and the judge prompt", async () => {
    const { calls, runner } = spy();
    const q = "Is the filing deadline binding?";
    await runPod({ market, siblings: sibs, book, runner, judge: fakeJudge, steering: steer({ question: q }) });
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(userPrompt(c.brief)).toContain(`Operator focus: ${q}`);
      expect(userPrompt(c.brief).split("Operator focus")[0]).not.toContain(q); // prose after the JSON, not inside it
    }
    let sent = "";
    const out = { content: [{ type: "text", text: JSON.stringify({ p_hat: 0.5, confidence: 0.5, thesis: "t", catalysts: [], kill_criteria: [], key_evidence: [] }) }], usage: { input_tokens: 1, output_tokens: 1 } };
    const client = { messages: { create: async (a: { messages: { content: string }[] }) => ((sent = a.messages[0]!.content), out) } };
    await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge: anthropicJudge(client as never), steering: steer({ question: q }) });
    expect(sent).toContain(`Operator focus: ${q}`);
    await runPod({ market, siblings: sibs, book, runner: fakeRunner, judge: anthropicJudge(client as never) });
    expect(sent).not.toContain("Operator focus");
  });

  it("per-role models reach the runner and judge; others fall back to settings, then defaults", async () => {
    const { calls, runner } = spy();
    let judgeModel: string | undefined;
    const judge: typeof fakeJudge = async (i) => { judgeModel = i.model; return fakeJudge(i); };
    await runPod({
      market, siblings: sibs, book, runner, judge, settings: { models: { news: "claude-opus-5-5" } },
      steering: steer({ models: { source: "claude-haiku-5-5", judge: "claude-sonnet-5-5" } }),
    });
    const m = Object.fromEntries(calls.map((c) => [c.role, c.o.model]));
    expect(m).toMatchObject({ source: "claude-haiku-5-5", news: "claude-opus-5-5", rules: "claude-haiku-5-5", red_team: "claude-sonnet-5-5" });
    expect(judgeModel).toBe("claude-sonnet-5-5");
  });

  it("exaCallCap / maxTurns: steering may only lower the settings values", async () => {
    const { calls, runner } = spy();
    await runPod({ market, siblings: sibs, book, runner, judge: fakeJudge, settings: { exaCallCap: 6, maxTurns: 12 }, steering: steer({ exaCallCap: 2, maxTurns: 50 }) });
    expect(calls.every((c) => c.o.exaCallCap === 2 && c.o.maxTurns === 12)).toBe(true);
  });

  it("maxCostUsd skips queued roles (recorded as skipped); judge still runs", async () => {
    let started = 0;
    const runner: typeof fakeRunner = async (role, brief, o) => { started++; return { ...(await fakeRunner(role, brief, o)), usage: { inputTokens: 0, outputTokens: 0, costUsd: 1 } }; };
    const r = await runPod({ market, siblings: sibs, book, runner, judge: fakeJudge, settings: { concurrency: 1 }, steering: steer({ maxCostUsd: 3 }) });
    expect(started).toBe(3);
    expect(r.agents.filter((a) => a.ok)).toHaveLength(3);
    expect(r.agents.filter((a) => !a.ok && a.skipped).map((a) => a.role)).toEqual(["news", "red_team"]);
    expect(r.judge.p_hat).toBeGreaterThan(0);
  });

  it("success threshold is min(3, roleCount)", async () => {
    const failing = (bad: string[]): RawRunner => async (role, brief, o) => { if (bad.includes(role)) throw new Error("boom"); return fakeRaw(role, brief, o); };
    const one = steer({ roles: ["source"] }), two = steer({ roles: ["source", "news"] });
    expect((await runPod({ market, siblings: sibs, book, runner: validated(failing([])), judge: fakeJudge, steering: one })).agents).toHaveLength(1);
    expect((await runPod({ market, siblings: sibs, book, runner: validated(failing([])), judge: fakeJudge, steering: two })).agents).toHaveLength(2);
    await expect(runPod({ market, siblings: sibs, book, runner: validated(failing(["source"])), judge: fakeJudge, steering: one })).rejects.toThrow(/pod failed/);
    await expect(runPod({ market, siblings: sibs, book, runner: validated(failing(["news"])), judge: fakeJudge, steering: two })).rejects.toThrow(/pod failed/);
  });
});

describe("validated", () => {
  it("retries once on schema failure with hint", async () => {
    const hints: (string | undefined)[] = [];
    const raw: RawRunner = async (role, brief, o) => {
      hints.push(o.hint);
      const r = await fakeRaw(role, brief, o);
      return hints.length === 1 ? { ...r, output: { nope: 1 } } : r;
    };
    const r = await validated(raw)("source", buildBrief(market, sibs), opts);
    expect(r.output.role).toBe("source");
    expect(hints[0]).toBeUndefined();
    expect(hints[1]).toMatch(/invalid/);
  });
  it("fails after second bad output", async () => {
    const raw: RawRunner = async (role, brief, o) => ({ ...(await fakeRaw(role, brief, o)), output: {} });
    await expect(validated(raw)("source", buildBrief(market, sibs), opts)).rejects.toThrow(/schema/);
  });
});

describe("backoff", () => {
  it("throws AnthropicOutageError after 4 retries on 529", async () => {
    let n = 0;
    const client = { messages: { create: async () => { n++; throw Object.assign(new Error("Overloaded"), { status: 529 }); } } };
    await expect(classifyR("rules", client as never, "m", noWait)).rejects.toBeInstanceOf(AnthropicOutageError);
    expect(n).toBe(5);
  });
  it("does not treat 429/rate-limit text without a status as overload", async () => {
    await expect(withBackoff(async () => { throw new Error("sandbox 429 rate limit"); }, noWait)).rejects.toThrow("sandbox 429");
  });
  it("classifies sandbox stderr: Anthropic overload yes, other 429s no", () => {
    expect(isOverloadText("API Error: 529 {\"type\":\"overloaded_error\"}")).toBe(true);
    expect(isOverloadText("Exa HTTP 429")).toBe(false);
  });
  it("recovers and ignores other errors", async () => {
    let n = 0;
    expect(await withBackoff(async () => (++n < 3 ? Promise.reject({ status: 429 }) : "ok"), noWait)).toBe("ok");
    await expect(withBackoff(async () => { throw new Error("bad"); }, noWait)).rejects.toThrow("bad");
  });
});

describe("classifyR", () => {
  it("parses and clamps", async () => {
    const client = { messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({ R: 1.4, objective_source: true, scheduled_event: false, public_data_release: true, rule_ambiguity: 0.2, note: "ok" }) }] }) } };
    expect((await classifyR("r", client as never)).R).toBe(1);
    expect(rulesHash("a")).toBe(rulesHash(" a "));
  });
});

describe("pickRunner", () => {
  it("env matrix", async () => {
    expect((await pickRunner({})).kind).toBe("fake");
    expect((await pickRunner({ VERCEL_OIDC_TOKEN: "t" })).kind).toBe("fake");
    expect((await pickRunner({ NODE_ENV: "production" })).kind).toBe("disabled");
    expect((await pickRunner({ VERCEL_ENV: "production" })).runner).toBe(disabledRunner);
    expect((await pickRunner({ NODE_ENV: "production", PM_FIXTURES: "1" })).kind).toBe("fake");
    expect((await pickRunner({ NODE_ENV: "development" })).kind).toBe("fake");
    // the Messages API runner is the default: the Agent SDK's native binary is not in a Vercel function bundle
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k" })).kind).toBe("api");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", VERCEL_OIDC_TOKEN: "t" })).kind).toBe("api");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", PM_RUNNER: "agent-sdk" })).kind).toBe("local");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", PM_RUNNER: "sandbox" })).kind).toBe("api"); // no creds: falls back
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", PM_RUNNER: "sandbox", VERCEL_OIDC_TOKEN: "t" })).kind).toBe("sandbox");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", PM_RUNNER: "sandbox", VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "x", VERCEL_PROJECT_ID: "p" })).kind).toBe("sandbox");
  });
});

describe("apiRunner", () => {
  const brief = { question: "Q?", rules: "r", tags: [], end_date: "2026-12-31T00:00:00Z", siblings: [] };
  const out = { role: "news", probability: 0.4, confidence: 0.5, key_facts: [], risks: [], notes: "n" };
  const usage = { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } };
  const opts = { model: "claude-sonnet-5-5", timeoutMs: 5_000, exaCallCap: 3 };
  /** Fake client: answers each request with the next scripted message and records the messages it was sent. */
  const scripted = (...replies: object[]) => {
    const sent: unknown[][] = [];
    const client = { messages: { stream: (req: { messages: unknown[] }) => { sent.push([...req.messages]); const r = replies.shift(); return { finalMessage: async () => r } } } };
    return { client: client as never, sent };
  };

  it("resumes pause_turn, records server tool calls, returns the submit_result input", async () => {
    const { client, sent } = scripted(
      { stop_reason: "pause_turn", usage, content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] },
      { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "t1", name: "submit_result", input: out }] },
    );
    const r = await apiRunner(client)("news", brief, opts);
    expect(r.output).toEqual(out);
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: "web_search", ok: false })]);
    expect(r.usage.costUsd).toBeGreaterThan(0.02); // two searches at $0.01 plus tokens
    expect(sent[1]).toHaveLength(2); // the paused assistant turn went back as-is, no extra user message
  });

  it("keeps the text it read: fetched documents and cited search passages, not PDFs", async () => {
    const turn = { stop_reason: "tool_use", usage, content: [
      { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://bls.gov/cpi", retrieved_at: null, content: { type: "document", title: null, citations: null, source: { type: "text", media_type: "text/plain", data: "CPI rose 3.7 percent." } } } },
      { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_result", url: "https://x.gov/a.pdf", retrieved_at: null, content: { type: "document", title: null, citations: null, source: { type: "base64", media_type: "application/pdf", data: "JVBE" } } } },
      { type: "text", text: "noted", citations: [{ type: "web_search_result_location", url: "https://reuters.com/fed", cited_text: "The Fed raised rates by 25 bp.", encrypted_index: "x", title: null }] },
      { type: "tool_use", id: "t", name: "submit_result", input: out },
    ] };
    const r = await apiRunner(scripted(turn).client)("news", brief, opts);
    expect(r.pages).toEqual([{ url: "https://bls.gov/cpi", text: "CPI rose 3.7 percent." }, { url: "https://reuters.com/fed", text: "The Fed raised rates by 25 bp." }]);
  });

  it("nudges a turn that ends without submit_result, then gives up", async () => {
    const text = { stop_reason: "end_turn", usage, content: [{ type: "text", text: "done" }] };
    const { client, sent } = scripted(text, { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "t", name: "submit_result", input: out }] });
    expect((await apiRunner(client)("news", brief, opts)).output).toEqual(out);
    expect(JSON.stringify(sent[1]!.at(-1))).toContain("submit_result");
    await expect(apiRunner(scripted(text, text, text, text, text, text, text).client)("news", brief, opts)).rejects.toThrow("never called submit_result");
  });

  it("maps the timer abort to TIMEOUT", async () => {
    const client = { messages: { stream: (_: unknown, o: { signal: AbortSignal }) => ({ finalMessage: () => new Promise((_r, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))) }) } };
    await expect(apiRunner(client as never)("news", brief, { ...opts, timeoutMs: 20 })).rejects.toThrow("TIMEOUT");
  });
});

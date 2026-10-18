import { describe, expect, it } from "vitest";
import type { Market } from "@pm/core";
import { AgentOutput } from "@pm/core";
import { AnthropicOutageError, isOverloadText, PodFailedError, buildBrief, classifyR, disabledRunner, fakeJudge, fakeRaw, fakeRunner, modelFor, pickRunner, rulesHash, runPod, validated, withBackoff } from "./index";
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

  it("caps confidence when estimates straddle p_mid", async () => {
    const p = { rules: null, source: 0.9, base_rate: 0.8, news: 0.2, red_team: 0.1 } as const;
    const raw: RawRunner = async (role, brief, o) => {
      const r = await fakeRaw(role, brief, o);
      return { ...r, output: { ...(r.output as object), probability: p[role] } };
    };
    const r = await runPod({ market, siblings: sibs, book, runner: validated(raw), judge: fakeJudge });
    expect(r.judge.confidence).toBe(0.5);
    expect(r.judge.capped).toBe(true);
  });

  it("capped means straddle tripped, even if judge confidence is already below the cap", async () => {
    const p = { rules: null, source: 0.9, base_rate: 0.8, news: 0.2, red_team: 0.1 } as const;
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
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k" })).kind).toBe("local");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", VERCEL_OIDC_TOKEN: "t" })).kind).toBe("sandbox");
    expect((await pickRunner({ ANTHROPIC_API_KEY: "k", VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "x", VERCEL_PROJECT_ID: "p" })).kind).toBe("sandbox");
  });
});

import type { Market } from "@pm/core";
import { describe, expect, it } from "vitest";
import { PodCancelledError, fakeJudge, fakeRunner, runPod, type AgentRunner } from "./index";

const market: Market = {
  conditionId: "c", eventId: "e", question: "Will X happen?", rules: "Resolves YES if X.", category: "politics", tags: [],
  endDate: Date.parse("2026-12-01"), negRiskGroup: null, feeRate: 0.02, open: true, acceptingOrders: true, inDispute: false,
};
const book = { bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.54, size: 100 }], pMid: 0.52 };
const base = { market, siblings: [], book, judge: fakeJudge };

describe("runPod hooks + signal", () => {
  it("emits stages and per-agent start/finish; fakeRunner returns tool calls", async () => {
    const log: string[] = [];
    const r = await runPod({
      ...base, runner: fakeRunner,
      hooks: {
        onStage: (s) => void log.push(`stage:${s}`),
        onAgentStart: async (role, model) => void log.push(`start:${role}:${model}`),
        onAgentFinish: (role, a) => void log.push(`finish:${role}:${a.ok}`),
      },
    });
    expect(log.filter((l) => l.startsWith("stage:"))).toEqual(["stage:rules", "stage:agents", "stage:judge"]);
    expect(log.filter((l) => l.startsWith("start:"))).toHaveLength(5);
    expect(log.filter((l) => l.startsWith("finish:"))).toHaveLength(5);
    expect(log.indexOf("start:news:claude-haiku-5-5")).toBeLessThan(log.indexOf("finish:news:true"));
    const news = r.agents.find((a) => a.role === "news")!;
    expect(news.ok && news.run.toolCalls!.every((c) => c.input.length <= 500 && c.ok)).toBe(true);
  });

  it("abort: running agents are cancelled, queued ones never start, completed ones are returned", async () => {
    const ac = new AbortController(), started: string[] = [], finished: Record<string, string> = {};
    const runner: AgentRunner = (role, brief, o) => {
      started.push(role);
      if (role !== "source") return fakeRunner(role, brief, o);
      return new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(new Error("cancelled"))));
    };
    const p = runPod({
      ...base, runner, settings: { concurrency: 2 },
      hooks: { onAgentFinish: (role, a) => { finished[role] = a.ok ? "ok" : a.cancelled ? "cancelled" : "failed"; if (role === "rules") ac.abort(); } },
      signal: ac.signal,
    });
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(PodCancelledError);
    expect(finished.source).toBe("cancelled");
    expect(finished.rules).toBe("ok");
    expect(started).not.toContain("red_team");
    expect((e as PodCancelledError).agents.map((a) => a.role)).toEqual(expect.arrayContaining(["rules", "source"]));
  });

  it("abort during the judge is a cancel, not a failure", async () => {
    const ac = new AbortController();
    const judge: typeof fakeJudge = (i) => { setTimeout(() => ac.abort(), 5); return new Promise(() => void i); };
    await expect(runPod({ ...base, runner: fakeRunner, judge, signal: ac.signal })).rejects.toBeInstanceOf(PodCancelledError);
  });

  it("an already-aborted signal rejects fakeRunner without work", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(fakeRunner("news", { question: "q", rules: "r", tags: [], end_date: "", siblings: [] }, { model: "m", timeoutMs: 1000, exaCallCap: 1, signal: ac.signal })).rejects.toThrow("cancelled");
  });
});

import { capConfidence, type AgentOutput, type Level, type Market, type Settings } from "@pm/core";
import type { Judge, JudgeOut } from "./judge";
import { buildBrief, type AgentRole } from "./prompts";
import { modelFor, type ModelRole } from "./router";
import type { AgentRunner, Run, Usage } from "./runner";

export const ROLES: AgentRole[] = ["rules", "source", "base_rate", "news", "red_team"];
const MIN_OK = 3;

export type PodSettings = {
  models?: Partial<Record<ModelRole, string>>;
  concurrency?: number;
  timeoutMs?: number; // per agent; default 10 min
  exaCallCap?: number; // per agent
  core?: Settings;
};
export type AgentResult = { role: AgentRole; model: string; ok: true; run: Run } | { role: AgentRole; model: string; ok: false; error: string };
export type EvidenceRow = { agent_role: AgentRole; claim: string; url: string; quote: string; date: string; direction: "+" | "-" };
export type PodResult = {
  agents: AgentResult[];
  judge: JudgeOut & { capped: boolean };
  evidence: EvidenceRow[];
  costs: Usage & { sandboxS: number };
};

export class PodFailedError extends Error {
  constructor(public agents: AgentResult[]) {
    super(`pod failed: ${agents.filter((a) => a.ok).length}/${agents.length} agents succeeded`);
  }
}

const trim = (q: string, n = 24) => q.trim().split(/\s+/).slice(0, n).join(" ");

export async function runPod(a: {
  market: Market;
  siblings: Market[];
  book: { bids: Level[]; asks: Level[]; pMid: number };
  settings?: PodSettings;
  runner: AgentRunner;
  judge: Judge;
  onAgentDone?: (r: AgentResult) => void;
}): Promise<PodResult> {
  const { settings = {}, book } = a;
  const brief = buildBrief(a.market, a.siblings);
  const agents: AgentResult[] = [];
  const queue = [...ROLES];
  const worker = async () => {
    for (let role = queue.shift(); role; role = queue.shift()) {
      const model = modelFor(role, settings.models);
      let r: AgentResult;
      try {
        const run = await a.runner(role, brief, { model, timeoutMs: settings.timeoutMs ?? 600_000, exaCallCap: settings.exaCallCap ?? 10 });
        r = { role, model, ok: true, run };
      } catch (e) {
        r = { role, model, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      agents.push(r);
      a.onAgentDone?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency ?? 5, ROLES.length) }, worker));
  agents.sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role));

  const ok = agents.flatMap((x) => (x.ok ? [x.run] : []));
  if (ok.length < MIN_OK) throw new PodFailedError(agents);
  const outputs: AgentOutput[] = ok.map((r) => r.output);

  const bidP = book.bids.map((l) => l.price), askP = book.asks.map((l) => l.price);
  const usd = (ls: Level[]) => ls.reduce((s, l) => s + l.price * l.size, 0);
  const j = await a.judge({
    brief,
    outputs,
    book: {
      pMid: book.pMid,
      bestBid: bidP.length ? Math.max(...bidP) : null,
      bestAsk: askP.length ? Math.min(...askP) : null,
      bidDepthUsd: usd(book.bids),
      askDepthUsd: usd(book.asks),
    },
  });

  const confidence = capConfidence(j.judge.confidence, outputs.map((o) => o.probability), book.pMid);
  const evidence = outputs.flatMap((o) =>
    o.key_facts.map((f): EvidenceRow => ({
      agent_role: o.role,
      claim: f.claim,
      url: f.url,
      quote: trim(f.quote),
      date: f.date,
      direction: o.probability == null || o.probability >= book.pMid ? "+" : "-",
    })),
  );
  const costs = [...ok.map((r) => r.usage), j.usage].reduce(
    (s, u) => ({ inputTokens: s.inputTokens + u.inputTokens, outputTokens: s.outputTokens + u.outputTokens, costUsd: s.costUsd + u.costUsd }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  return {
    agents,
    judge: { ...j.judge, confidence, capped: confidence < j.judge.confidence },
    evidence,
    costs: { ...costs, sandboxS: ok.reduce((s, r) => s + r.sandboxS, 0) },
  };
}

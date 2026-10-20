import { DEFAULT_STEERING, capConfidence, straddles, type AgentOutput, type Level, type Market, type Settings, type Steering } from "@pm/core";
import type { Judge, JudgeOut } from "./judge";
import { COMMON, buildBrief, type AgentRole } from "./prompts";
import { AnthropicOutageError, isOverload } from "./backoff";
import { modelFor, type ModelRole } from "./router";
import type { AgentRunner, Run, Usage } from "./runner";

export const ROLES: AgentRole[] = ["rules", "source", "base_rate", "news", "red_team"];

export type PodSettings = {
  models?: Partial<Record<ModelRole, string>>;
  concurrency?: number;
  timeoutMs?: number; // per agent; default 10 min
  agentsMs?: number; // hard wall-clock budget for the whole agent phase (all waves); default none
  judgeMs?: number; // hard wall-clock budget for the judge call; default none
  exaCallCap?: number; // per agent; steering may only lower it
  maxTurns?: number; // per agent; default 20, steering may only lower it
  core?: Settings;
};
export type AgentResult =
  | { role: AgentRole; model: string; ok: true; run: Run }
  | { role: AgentRole; model: string; ok: false; error: string; outage: boolean; skipped?: true; cancelled?: true }; // skipped: never started (cost cap); cancelled: aborted mid-run
export type EvidenceRow = { agent_role: AgentRole; claim: string; url: string; quote: string; date: string; direction: "+" | "-" };
export type PodResult = {
  agents: AgentResult[];
  judge: JudgeOut & { capped: boolean };
  evidence: EvidenceRow[];
  costs: Usage & { sandboxS: number };
};

export type PodStage = "rules" | "agents" | "judge" | "sizing" | "done";
type Hook<A extends unknown[]> = (...a: A) => void | Promise<void>;
/** Lifecycle callbacks; awaited, so a slow hook delays the pod. runPod emits rules, agents, judge; the caller owns sizing and done. */
export type PodHooks = {
  onStage?: Hook<[PodStage]>;
  onAgentStart?: Hook<[AgentRole, string]>; // not called for skipped agents
  onAgentFinish?: Hook<[AgentRole, AgentResult]>; // ok, failed, skipped or cancelled
};

/** `signal` aborted mid-run: `agents` holds what ran (completed ones keep their usage). */
export class PodCancelledError extends Error {
  constructor(public agents: AgentResult[], public stage: PodStage = "agents") { super("pod cancelled"); } // stage: where the abort landed ("judge" => a judge call was in flight)
}

export class PodFailedError extends Error {
  constructor(public agents: AgentResult[], public cause?: unknown) {
    super(`pod failed: ${agents.filter((a) => a.ok).length}/${agents.length} agents succeeded${cause ? ` (${cause instanceof Error ? cause.message : cause})` : ""}`);
  }
}

/** A pod phase ran out of wall-clock budget (the host function window); recorded as reason TIMEOUT. */
export class PodTimeoutError extends Error {
  constructor(public what: string) { super(`TIMEOUT: ${what}`); }
}
/** Hard stop: retries/backoff inside `p` can outlive its own timeout, so race it. `p` keeps running but is ignored. */
const within = <T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal) => {
  if (!Number.isFinite(ms) && !signal) return p;
  let t: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => {
    if (Number.isFinite(ms)) t = setTimeout(() => rej(new PodTimeoutError(what)), Math.max(0, ms));
    if (signal) { onAbort = () => rej(new Error("cancelled")); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  })]).finally(() => { clearTimeout(t); if (onAbort) signal!.removeEventListener("abort", onAbort); });
};

const trim = (q: string, n = 24) => q.trim().split(/\s+/).slice(0, n).join(" ");

export async function runPod(a: {
  market: Market;
  siblings: Market[];
  book: { bids: Level[]; asks: Level[]; pMid: number };
  settings?: PodSettings;
  steering?: Steering;
  runner: AgentRunner;
  judge: Judge;
  onAgentDone?: (r: AgentResult) => void;
  hooks?: PodHooks;
  signal?: AbortSignal; // abort => running agents are cancelled, nothing new starts, PodCancelledError
}): Promise<PodResult> {
  const { settings = {}, book, hooks, signal } = a;
  await hooks?.onStage?.("rules");
  const st = a.steering ?? DEFAULT_STEERING;
  const models = { ...settings.models, ...st.models }; // steering wins over settings
  const brief = { ...buildBrief(a.market, a.siblings), ...(st.question ? { focus: st.question } : {}) };
  const custom = new Map(st.customRoles.map((r) => [r.key, `${COMMON}\nRole key: role="${r.key}".\n${r.prompt}`]));
  const roles: AgentRole[] = [...st.roles, ...custom.keys()];
  const exaCap = Math.min(st.exaCallCap ?? Infinity, settings.exaCallCap ?? 10), turnCap = settings.maxTurns ?? 20;
  const maxTurns = Math.min(st.maxTurns ?? Infinity, turnCap);
  const agents: AgentResult[] = [];
  let spent = 0;
  const queue = [...roles];
  const t0 = Date.now(), agentsEnd = t0 + (settings.agentsMs ?? Infinity);
  const finish = async (r: AgentResult) => {
    agents.push(r);
    a.onAgentDone?.(r);
    await hooks?.onAgentFinish?.(r.role, r);
  };
  const worker = async () => {
    for (let role = queue.shift(); role && !signal?.aborted; role = queue.shift()) {
      const model = modelFor(role, models);
      let r: AgentResult;
      if (st.maxCostUsd != null && spent >= st.maxCostUsd) {
        await finish({ role, model, ok: false, error: "skipped: maxCostUsd reached", outage: false, skipped: true });
        continue;
      }
      const left = agentsEnd - Date.now();
      if (left <= 0) {
        await finish({ role, model, ok: false, error: "TIMEOUT: agent phase budget spent before start", outage: false, skipped: true });
        continue;
      }
      await hooks?.onAgentStart?.(role, model);
      try {
        const run = await within(a.runner(role, brief, { model, timeoutMs: Math.min(settings.timeoutMs ?? 600_000, left), exaCallCap: exaCap, maxTurns, system: custom.get(role), deadline: agentsEnd, signal }), left, `agent ${role}`, signal);
        spent += run.usage.costUsd;
        r = { role, model, ok: true, run };
      } catch (e) {
        r = signal?.aborted
          ? { role, model, ok: false, error: "cancelled", outage: false, cancelled: true }
          : { role, model, ok: false, error: e instanceof Error ? e.message : String(e), outage: e instanceof AnthropicOutageError || isOverload(e) };
      }
      await finish(r);
    }
  };
  await hooks?.onStage?.("agents");
  await Promise.all(Array.from({ length: Math.min(settings.concurrency ?? 5, roles.length) }, worker));
  agents.sort((x, y) => roles.indexOf(x.role) - roles.indexOf(y.role));
  if (signal?.aborted) throw new PodCancelledError(agents);

  const ok = agents.flatMap((x) => (x.ok ? [x.run] : []));
  if (ok.length < Math.min(3, roles.length)) throw new PodFailedError(agents, agents.some((x) => !x.ok && x.error.startsWith("TIMEOUT")) ? new PodTimeoutError("agents") : undefined);
  const outputs: AgentOutput[] = ok.map((r) => r.output);

  const bidP = book.bids.map((l) => l.price), askP = book.asks.map((l) => l.price);
  const usd = (ls: Level[]) => ls.reduce((s, l) => s + l.price * l.size, 0);
  await hooks?.onStage?.("judge");
  const judgeEnd = Date.now() + (settings.judgeMs ?? Infinity);
  const j = await within(a.judge({
    deadline: judgeEnd,
    signal,
    brief,
    outputs,
    model: modelFor("judge", models),
    book: {
      pMid: book.pMid,
      bestBid: bidP.length ? Math.max(...bidP) : null,
      bestAsk: askP.length ? Math.min(...askP) : null,
      bidDepthUsd: usd(book.bids),
      askDepthUsd: usd(book.asks),
    },
  }), settings.judgeMs ?? Infinity, "judge", signal).catch((e) => { throw signal?.aborted ? new PodCancelledError(agents, "judge") : new PodFailedError(agents, e); });

  const probs = outputs.map((o) => o.probability);
  const confidence = capConfidence(j.judge.confidence, probs, book.pMid);
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
    judge: { ...j.judge, confidence, capped: straddles(probs, book.pMid) },
    evidence,
    costs: { ...costs, sandboxS: ok.reduce((s, r) => s + r.sandboxS, 0) },
  };
}

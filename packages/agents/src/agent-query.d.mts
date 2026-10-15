export type AgentInput = {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  exaCallCap: number;
  exaKey: string;
  timeoutMs: number;
  maxTurns?: number;
};
export function runAgent(input: AgentInput): Promise<{ output: unknown; usage: { inputTokens: number; outputTokens: number; costUsd: number } }>;

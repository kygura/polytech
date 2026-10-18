export class AnthropicOutageError extends Error {
  constructor(public attempts: number, public cause?: unknown) {
    super(`Anthropic overloaded/rate-limited after ${attempts} attempts`);
    this.name = "AnthropicOutageError";
  }
}

export const isOverload = (e: unknown) => {
  const st = (e as { status?: number } | null)?.status;
  return st === 429 || st === 529;
};

/** Sandbox stderr (plain Error, no .status): did the Anthropic API overload/rate-limit the agent? */
export const isOverloadText = (s: string) => /overloaded_error|rate_limit_error|API Error: (429|529)\b/i.test(s);

export type BackoffOpts = { retries?: number; baseMs?: number; deadline?: number }; // deadline: epoch ms, no new attempt starts past it

/** Exponential backoff on 429/529; other errors pass through. */
export async function withBackoff<T>(fn: () => Promise<T>, { retries = 4, baseMs = 1000, deadline = Infinity }: BackoffOpts = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isOverload(e)) throw e;
      if (i >= retries) throw new AnthropicOutageError(i + 1, e);
      const wait = baseMs * 2 ** i;
      if (Date.now() + wait >= deadline) throw new Error("TIMEOUT: deadline reached while backing off");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

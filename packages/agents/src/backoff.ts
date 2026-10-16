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

export type BackoffOpts = { retries?: number; baseMs?: number };

/** Exponential backoff on 429/529; other errors pass through. */
export async function withBackoff<T>(fn: () => Promise<T>, { retries = 4, baseMs = 1000 }: BackoffOpts = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isOverload(e)) throw e;
      if (i >= retries) throw new AnthropicOutageError(i + 1, e);
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
}

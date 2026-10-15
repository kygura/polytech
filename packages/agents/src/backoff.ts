export class AnthropicOutageError extends Error {
  constructor(public attempts: number, public cause?: unknown) {
    super(`Anthropic overloaded/rate-limited after ${attempts} attempts`);
    this.name = "AnthropicOutageError";
  }
}

export const isOverload = (e: unknown) => {
  const x = e as { status?: number; message?: string } | null;
  return x?.status === 429 || x?.status === 529 || /overloaded|rate.?limit|\b(429|529)\b/i.test(x?.message ?? "");
};

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

/** Token bucket: `limit` tokens per `windowMs`. take() resolves immediately or after the needed delay; never rejects. */
export function bucket(limit: number, windowMs: number) {
  const rate = limit / windowMs;
  let tokens = limit;
  let last = Date.now();
  return async (): Promise<void> => {
    const now = Date.now();
    tokens = Math.min(limit, tokens + (now - last) * rate);
    last = now;
    tokens -= 1; // may go negative: later callers queue behind earlier ones
    if (tokens < 0) await new Promise((r) => setTimeout(r, Math.ceil(-tokens / rate)));
  };
}

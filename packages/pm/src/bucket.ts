export type BucketOpts = {
  /** Max tokens held when idle (burst size). Default: `limit`. A smaller burst smooths a parallel fan-out so Cloudflare never sees a spike. */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
export type Take = (() => Promise<void>) & {
  /**
   * HTTP 429 feedback: drops the stored tokens and makes the queue sit out `ms` (the server's Retry-After) before anything
   * else is sent. After the pause the queue resumes at the sustained rate, one request per refill interval, never as a burst.
   * Never rejects anyone.
   */
  penalize(ms?: number): void;
};

/**
 * FIFO-fair token bucket: `limit` tokens per `windowMs`, refilled continuously.
 * take() resolves immediately while tokens remain, otherwise after the needed delay; callers are served in call order
 * (a chained tail promise), so a burst of 25 parallel chunks never starves the one that asked first.
 * Never rejects. Clock and sleep are injectable for tests.
 */
export function bucket(limit: number, windowMs: number, o: BucketOpts = {}): Take {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const burst = o.burst ?? limit;
  const rate = limit / windowMs; // tokens per ms
  let tokens = burst;
  let last = now();
  let penalty = 0; // ms the queue must wait (Retry-After), consumed once
  let tail: Promise<void> = Promise.resolve();
  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + (t - last) * rate);
    last = t;
  };
  const run = async () => {
    for (;;) {
      while (penalty > 0) {
        const ms = penalty;
        penalty = 0; // a 429 landing during this sleep re-arms it and loops once more
        await sleep(ms);
        tokens = Math.min(tokens, 0); // no refill credit for the pause: the queue leaves the ban at the sustained rate, not with a burst
        last = now();
      }
      refill();
      tokens -= 1; // may go negative: the deficit is this caller's wait, the next caller queues behind it
      if (tokens >= 0) return;
      await sleep(Math.ceil(-tokens / rate));
      if (penalty <= 0) return;
      tokens += 1; // a 429 landed while we slept: hand the token back and wait the penalty out before anything goes out
    }
  };
  const take = (() => {
    const p = tail.then(run);
    tail = p.catch(() => {});
    return p;
  }) as Take;
  take.penalize = (ms = 0) => {
    refill();
    tokens = Math.min(tokens, 0);
    penalty = Math.max(penalty, ms);
  };
  return take;
}

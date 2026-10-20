import { describe, expect, it } from "vitest";
import { bucket } from "./bucket";

/** Deterministic clock: sleeping advances time. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, advance: (ms: number) => (t += ms) };
}

describe("token bucket", () => {
  it("burst is free, then paced at the refill rate", async () => {
    const c = clock();
    const take = bucket(10, 1000, { burst: 3, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 3; i++) await take();
    expect(c.slept).toEqual([]);
    await take();
    await take();
    expect(c.slept).toEqual([100, 100]); // 10/s -> one token per 100 ms
  });
  it("refills over time but never beyond the burst", async () => {
    const c = clock();
    const take = bucket(10, 1000, { burst: 2, now: c.now, sleep: c.sleep });
    await take();
    await take();
    c.advance(10_000);
    await take();
    await take();
    expect(c.slept).toEqual([]);
    await take(); // only 2 tokens had accumulated
    expect(c.slept).toEqual([100]);
  });
  it("concurrent callers are served FIFO and the total wait matches the rate", async () => {
    const c = clock();
    const take = bucket(5, 1000, { burst: 1, now: c.now, sleep: c.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(c.now()).toBe(600); // 3 waits of 200 ms
  });
  it("penalize() drops the stored burst: the next caller waits a full refill interval", async () => {
    const c = clock();
    const take = bucket(10, 1000, { burst: 5, now: c.now, sleep: c.sleep });
    take.penalize();
    await take();
    expect(c.slept).toEqual([100]);
  });
  it("penalize(ms) honours Retry-After once for the whole queue, then resumes at the normal rate", async () => {
    const c = clock();
    const take = bucket(100, 1000, { burst: 10, now: c.now, sleep: c.sleep });
    take.penalize(5000);
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2]);
    expect(c.slept).toEqual([5000]); // one Retry-After sleep covers everyone queued behind it; the refill it earned is credited
    expect(c.now()).toBe(5000);
  });
  it("never rejects", async () => {
    const c = clock();
    const take = bucket(1, 1000, { now: c.now, sleep: c.sleep });
    await expect(Promise.all([take(), take(), take()])).resolves.toHaveLength(3);
  });
});

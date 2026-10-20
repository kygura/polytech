import { afterEach, describe, expect, it, vi } from "vitest";
import { memo, memoClear } from "./memo";

afterEach(() => { vi.useRealTimers(); memoClear(); });

describe("memo", () => {
  it("concurrent callers share one in-flight call; the value is served until the TTL", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => Math.random());
    const [a, b] = await Promise.all([memo("k", 1000, fn), memo("k", 1000, fn)]);
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await memo("k", 1000, fn)).toBe(a);
    vi.advanceTimersByTime(1001);
    expect(await memo("k", 1000, fn)).not.toBe(a);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("a rejection is not cached; keys are independent; memoClear drops by prefix", async () => {
    const bad = vi.fn(async () => { throw new Error("x"); });
    await expect(memo("e", 1000, bad)).rejects.toThrow("x");
    expect(await memo("e", 1000, async () => 1)).toBe(1);
    await memo("p:a", 1000, async () => "a"); await memo("q:a", 1000, async () => "q");
    memoClear("p:");
    expect(await memo("p:a", 1000, async () => "a2")).toBe("a2");
    expect(await memo("q:a", 1000, async () => "q2")).toBe("q");
  });
});

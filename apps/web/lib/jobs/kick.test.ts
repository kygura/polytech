import { memoryKv } from "@pm/db";
import { describe, expect, it, vi } from "vitest";
import { kickIfStale } from "./kick";

const MIN = 60_000;

describe("kickIfStale", () => {
  it("stale + lock free: starts once; concurrent and follow-up kicks do not", async () => {
    const kv = memoryKv(), run = vi.fn(async () => {});
    const t = Date.now();
    expect(await Promise.all([kickIfStale(kv, t, run), kickIfStale(kv, t, run)])).toEqual(expect.arrayContaining([true, false]));
    expect(await kickIfStale(kv, t + 5 * MIN, run)).toBe(false); // fresh
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("fresh: no start", async () => {
    const kv = memoryKv(), run = vi.fn(async () => {});
    await kv.set("kick:sweepAt", Date.now() - 10 * MIN);
    expect(await kickIfStale(kv, Date.now(), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("stale but lock held: no start", async () => {
    const kv = memoryKv(), run = vi.fn(async () => {});
    await kv.set("kick:sweepAt", Date.now() - 40 * MIN);
    await kv.lock("kick", 10 * MIN);
    expect(await kickIfStale(kv, Date.now(), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("start error propagates (route logs it)", async () => {
    await expect(kickIfStale(memoryKv(), Date.now(), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

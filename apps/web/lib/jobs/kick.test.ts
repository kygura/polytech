import { memoryKv } from "@pm/db";
import { describe, expect, it, vi } from "vitest";
import { kickIfStale, runChain } from "./kick";

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
    await kv.set("kick:startedAt", Date.now() - 10 * MIN);
    expect(await kickIfStale(kv, Date.now(), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("stale but lock held: no start", async () => {
    const kv = memoryKv(), run = vi.fn(async () => {});
    await kv.set("kick:startedAt", Date.now() - 40 * MIN);
    await kv.lock("kick", 10 * MIN);
    expect(await kickIfStale(kv, Date.now(), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("a recent sweep does not suppress the kick", async () => {
    const kv = memoryKv(), run = vi.fn(async () => {});
    await kv.set("kick:sweepAt", Date.now() - MIN);
    expect(await kickIfStale(kv, Date.now(), run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("start error propagates (route logs it)", async () => {
    await expect(kickIfStale(memoryKv(), Date.now(), async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

describe("runChain (inline, no workflow wrapper)", () => {
  it("runs the steps in cron order and a failing step does not block the later ones", async () => {
    const seen: string[] = [], err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runChain(async (n, sc) => { seen.push(sc ? `${n}:${sc}` : n); if (n === "screen") throw new Error("boom"); });
    expect(seen).toEqual(["sweep", "snapshot:all", "screen", "research", "monitor"]);
    expect(err).toHaveBeenCalledWith("chain: screen failed", expect.any(Error));
    err.mockRestore();
  });
  it("startChain off Vercel runs inline and never calls the workflow function directly", async () => {
    vi.stubEnv("VERCEL", "");
    const jobs = { sweep: vi.fn(), snapshot: vi.fn(), screen: vi.fn(), research: vi.fn(), monitor: vi.fn() };
    vi.doMock("../api", () => ({ JOBS: jobs }));
    const { startChain: fresh } = await import("./kick");
    await fresh();
    expect(jobs.sweep).toHaveBeenCalledTimes(1);
    expect(jobs.snapshot).toHaveBeenCalledWith("all");
    expect(jobs.monitor).toHaveBeenCalledTimes(1);
    vi.doUnmock("../api"); vi.unstubAllEnvs();
  });
});

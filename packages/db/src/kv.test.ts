import { beforeAll, describe, expect, it } from "vitest";
import { getDb, migrate } from "./client";
import { pgKv, type Kv } from "./kv";

process.env.PGLITE_DIR = "memory://";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let kv: Kv;

beforeAll(async () => {
  await migrate();
  kv = pgKv(getDb());
}, 60_000); // PGlite migrate is slow under the full parallel test run

describe("pgKv (kv table)", () => {
  it("lock: one holder; release only frees our own hold; an expired hold can be taken over", async () => {
    const a = await kv.lock("job", 60_000);
    expect(a).not.toBeNull();
    expect(await kv.lock("job", 60_000)).toBeNull();
    await a!();
    const b = await kv.lock("job", 80);
    expect(b).not.toBeNull();
    await sleep(150);
    const c = await kv.lock("job", 60_000); // b expired
    expect(c).not.toBeNull();
    await b!(); // stale owner: must not free c
    expect(await kv.lock("job", 60_000)).toBeNull();
    await c!();
  });
  it("rateLimit: `limit` hits per window, then refused", async () => {
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await kv.rateLimit("ip:1", 3, 60_000));
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false]);
    expect(r.map((x) => x.remaining)).toEqual([2, 1, 0, 0]);
    expect((await kv.rateLimit("ip:2", 3, 60_000)).ok).toBe(true);
  });
  it("get/set: JSON values, ttl expiry, overwrite", async () => {
    expect(await kv.get("missing")).toBeNull();
    await kv.set("n", 42);
    await kv.set("o", { a: [1, "x"] });
    await kv.set("t", "soon", 80);
    expect(await kv.get<number>("n")).toBe(42);
    expect(await kv.get("o")).toEqual({ a: [1, "x"] });
    expect(await kv.get("t")).toBe("soon");
    await sleep(150);
    expect(await kv.get("t")).toBeNull();
    await kv.set("n", 43);
    expect(await kv.get<number>("n")).toBe(43);
  });
});

/**
 * Store conformance: every case runs on the memory backend and, when REDIS_TEST_URL is set (CI starts a redis service;
 * locally `redis-server --port 6390` + REDIS_TEST_URL=redis://127.0.0.1:6390), on real Redis through the Lua scripts.
 */
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryBackend, type Backend } from "./backend";
import { ioredisConn } from "./conn";
import { createStore, UniqueViolation } from "./db";
import { redisBackend } from "./redis";
import { boolean, json, num, serial, table, text, timestamp, uuid } from "./table";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const items = table("items", {
  id: text().primaryKey(),
  group: text().notNull(),
  status: text().notNull().default("open"),
  score: num(),
  at: timestamp().notNull().defaultNow(),
  tags: json<string[]>().notNull().default([]),
  code: text().unique(),
  flag: boolean().notNull().default(false),
}, {
  indexes: { group: { on: ["group"], sort: "at" }, status: { on: ["status"] }, byScore: { on: [], sort: "score" }, flagged: { on: [], when: (r) => r.flag } },
  unique: { onePending: { on: ["group"], when: (r) => r.status === "pending" } },
});
const logs = table("logs", { id: serial(), item: text().notNull(), n: num().notNull() }, { indexes: { item: { on: ["item"], sort: "id" } } });
const pairs = table("pairs", { a: text().notNull(), b: text().notNull(), v: num() }, { pk: ["a", "b"] });
const props = table("props", { id: uuid().primaryKey().defaultRandom(), name: text().notNull() });
const tables = { items, logs, pairs, props };

const backends: [string, () => Backend][] = [["memory", () => memoryBackend()]];
const url = process.env.REDIS_TEST_URL;
const conns: Redis[] = [];
if (url) backends.push(["redis", () => {
  const r = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  conns.push(r);
  return redisBackend(ioredisConn(r), `{pmtest${process.pid}}:`);
}]);
afterAll(async () => { for (const r of conns) { const b = redisBackend(ioredisConn(r), `{pmtest${process.pid}}:`); await b.flush(); r.disconnect(); } });

describe.each(backends)("store on %s", (_name, mk) => {
  const b = mk();
  const db = createStore(b, tables);
  beforeEach(() => db.flush());

  it("insert applies defaults, fills every column, round-trips types", async () => {
    const r = await db.items.insert({ id: "a", group: "g", score: 1.5, code: "X" });
    expect(r).toMatchObject({ id: "a", status: "open", tags: [], flag: false, code: "X" });
    expect(r.at).toBeInstanceOf(Date);
    const got = await db.items.get("a");
    expect(got).toEqual(r);
    await db.items.insert({ id: "inf", group: "g", score: Infinity });
    expect((await db.items.get("inf"))!.score).toBe(Infinity);
    expect(await db.items.get("missing")).toBeNull();
  });

  it("insert refuses a taken key and a taken unique value; nulls never collide", async () => {
    await db.items.insert({ id: "a", group: "g", code: "X" });
    await expect(db.items.insert({ id: "a", group: "h" })).rejects.toBeInstanceOf(UniqueViolation);
    await expect(db.items.insert({ id: "b", group: "h", code: "X" })).rejects.toBeInstanceOf(UniqueViolation);
    await db.items.insert({ id: "c", group: "h" });
    await db.items.insert({ id: "d", group: "h" }); // two null codes
    expect(await db.items.insertIfAbsent({ id: "a", group: "z" })).toBeNull();
    expect(await db.items.insertIfAbsent({ id: "e", group: "z", code: "X" })).toBeNull();
    expect((await db.items.insertIfAbsent({ id: "e", group: "z", code: "Y" }))?.id).toBe("e");
    expect((await db.items.byUnique("code", { code: "Y" }))?.id).toBe("e");
    await expect(db.items.insertMany([{ id: "f", group: "q", code: "Z" }, { id: "g", group: "q", code: "Z" }])).rejects.toBeInstanceOf(UniqueViolation);
    expect(await db.items.get("f")).toBeNull(); // the batch is atomic
  });

  it("partial unique: one pending per group; released when the row leaves the partition", async () => {
    await db.items.insert({ id: "p1", group: "g", status: "pending" });
    await expect(db.items.insert({ id: "p2", group: "g", status: "pending" })).rejects.toBeInstanceOf(UniqueViolation);
    await db.items.insert({ id: "p3", group: "g", status: "rejected" });
    await db.items.update("p1", { status: "approved" });
    await db.items.insert({ id: "p2", group: "g", status: "pending" });
    await expect(db.items.update("p3", { status: "pending" })).rejects.toBeInstanceOf(UniqueViolation);
    // swap inside one transaction: p2 gives up the slot, p3 takes it
    await db.tx(async (tx) => { await tx.items.update("p2", { status: "done" }); await tx.items.update("p3", { status: "pending" }); });
    expect((await db.items.find("status", { status: "pending" })).map((r) => r.id)).toEqual(["p3"]);
  });

  it("indexes follow updates and deletes; find orders, ranges, pages and merges partitions", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) await db.items.insert({ id: `i${i}`, group: i % 2 ? "odd" : "even", at: new Date(t0 + i * 1000), score: 5 - i });
    expect((await db.items.find("group", { group: "even" })).map((r) => r.id)).toEqual(["i0", "i2", "i4"]);
    expect((await db.items.find("group", { group: "even" }, { order: "desc", limit: 2 })).map((r) => r.id)).toEqual(["i4", "i2"]);
    expect((await db.items.find("group", { group: "even" }, { gt: new Date(t0), lt: t0 + 4000 })).map((r) => r.id)).toEqual(["i2"]);
    expect((await db.items.find("group", { group: "even" }, { min: t0, max: t0 + 4000, offset: 1 })).map((r) => r.id)).toEqual(["i2", "i4"]);
    expect((await db.items.find("group", [{ group: "even" }, { group: "odd" }], { order: "desc", limit: 3 })).map((r) => r.id)).toEqual(["i4", "i3", "i2"]);
    expect((await db.items.find("byScore", {}, { limit: 2 })).map((r) => r.id)).toEqual(["i4", "i3"]);
    expect(await db.items.count("group", { group: "odd" })).toBe(2);
    expect(await db.items.count("group", { group: "even" }, { min: t0 + 1000 })).toBe(2);
    await db.items.update("i0", { group: "odd" });
    expect(await db.items.ids("group", { group: "odd" })).toEqual(["i0", "i1", "i3"]);
    await db.items.delete("i1");
    expect(await db.items.ids("group", { group: "odd" })).toEqual(["i0", "i3"]);
    expect((await db.items.first("group", { group: "odd" }, { order: "desc" }))?.id).toBe("i3");
    await db.items.update("i3", { flag: true });
    expect(await db.items.ids("flagged", {})).toEqual(["i3"]);
    await db.items.update("i3", { flag: false });
    expect(await db.items.ids("flagged", {})).toEqual([]);
    await db.items.update("i2", { score: null });
    expect((await db.items.find("byScore", {}))[0]?.id).toBe("i2"); // null sorts first
    expect((await db.items.all()).length).toBe(4);
  });

  it("update is compare-and-set: concurrent increments all land; fn returning null changes nothing", async () => {
    await db.items.insert({ id: "c", group: "g", score: 0 });
    await Promise.all(Array.from({ length: 25 }, () => db.items.update("c", (r) => ({ score: (r.score ?? 0) + 1 }))));
    expect((await db.items.get("c"))!.score).toBe(25);
    expect(await db.items.update("c", (r) => (r.status === "pending" ? { status: "x" } : null))).toBeNull();
    expect(await db.items.update("nope", { score: 1 })).toBeNull();
    // only one of N racing claimers wins a status transition
    const won = await Promise.all(Array.from({ length: 10 }, () => db.items.update("c", (r) => (r.status === "open" ? { status: "taken" } : null))));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it("upsert inserts or patches; function form sees the current row", async () => {
    await db.items.upsert({ id: "u", group: "g", score: 1 });
    await db.items.upsert({ id: "u", group: "g", score: 2 }, (cur) => ({ score: (cur.score ?? 0) + 2 }));
    expect((await db.items.get("u"))!.score).toBe(3);
    await db.items.upsert({ id: "u", group: "h" });
    expect((await db.items.get("u"))!.group).toBe("h");
    expect(await db.items.ids("group", { group: "g" })).toEqual([]);
    const rows = await db.items.upsertMany([{ id: "v", group: "a", score: 1 }, { id: "v", group: "a", score: 5 }], (c) => ({ score: c.score! + 10 }));
    expect(rows.at(-1)!.score).toBe(11);
    await Promise.all(Array.from({ length: 10 }, () => db.items.upsert({ id: "w", group: "a", score: 1 }, (c) => ({ score: c.score! + 1 }))));
    expect((await db.items.get("w"))!.score).toBe(10);
  });

  it("serial ids, composite keys, uuid defaults", async () => {
    const a = await db.logs.insertMany([{ item: "x", n: 1 }, { item: "x", n: 2 }, { item: "y", n: 3 }]);
    expect(a.map((r) => r.id)).toEqual([1, 2, 3]);
    expect((await db.logs.insert({ item: "x", n: 4 })).id).toBe(4);
    expect((await db.logs.find("item", { item: "x" }, { order: "desc", limit: 1 }))[0]?.n).toBe(4);
    await b.seqAtLeast("logs", 100);
    expect((await db.logs.insert({ item: "x", n: 5 })).id).toBe(101);
    await db.pairs.insert({ a: "1", b: "2", v: 1 });
    expect((await db.pairs.get(["1", "2"]))?.v).toBe(1);
    expect(await db.pairs.get(["2", "1"])).toBeNull();
    await expect(db.pairs.insert({ a: "1", b: "2" })).rejects.toBeInstanceOf(UniqueViolation);
    expect((await db.props.insert({ name: "n" })).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("tx: atomic across tables; a conflicting write re-runs it; a throw writes nothing", async () => {
    await db.items.insert({ id: "t", group: "g", score: 0 });
    await expect(db.tx(async (tx) => {
      await tx.logs.insert({ item: "t", n: 1 });
      await tx.items.update("t", { score: 1 });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.items.get("t"))!.score).toBe(0);
    expect(await db.logs.ids("item", { item: "t" })).toEqual([]);
    let runs = 0;
    await db.tx(async (tx) => {
      runs++;
      const cur = await tx.items.get("t");
      if (runs === 1) await db.items.update("t", { score: 100 }); // someone else writes in between
      await tx.items.update("t", { score: cur!.score! + 1 });
      await tx.logs.insert({ item: "t", n: cur!.score! });
    });
    expect(runs).toBe(2);
    expect((await db.items.get("t"))!.score).toBe(101);
    expect((await db.logs.find("item", { item: "t" })).map((r) => r.n)).toEqual([100]);
  });

  it("bulk writes over the chunk size, deleteMany with a predicate", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ item: `k${i % 3}`, n: i }));
    expect((await db.logs.insertMany(rows)).length).toBe(450);
    expect(await db.logs.count("item", { item: "k0" })).toBe(150);
    const ids = await db.logs.ids("item", { item: "k1" });
    const gone = await db.logs.deleteMany(ids, (r) => r.n < 100);
    expect(gone.length).toBe(33);
    expect(await db.logs.count("item", { item: "k1" })).toBe(117);
    expect((await db.logs.updateMany(await db.logs.ids("item", { item: "k2" }), (r) => (r.n % 2 ? { n: -1 } : null))).length).toBe(75);
  });

  it("findEach: per-partition results in one call; upsertBy keys on a unique column", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 6; i++) await db.items.insert({ id: `e${i}`, group: `g${i % 3}`, at: new Date(t0 + i) });
    const each = await db.items.findEach("group", [{ group: "g2" }, { group: "none" }, { group: "g0" }], { order: "desc", limit: 1 });
    expect(each.map((l) => l.map((r) => r.id))).toEqual([["e5"], [], ["e3"]]);
    const many = await db.items.findEach("group", Array.from({ length: 250 }, (_, i) => ({ group: `g${i % 3}` })));
    expect(many.length).toBe(250);
    expect(many[249]!.map((r) => r.id)).toEqual(["e0", "e3"]);
    const a = await db.props.insert({ name: "x" });
    const pp = table("pp", { id: uuid().primaryKey().defaultRandom(), name: text().notNull().unique(), q: num() });
    const db2 = createStore(b, { pp });
    const u1 = await db2.pp.upsertBy("name", { name: "v", q: 1 });
    const u2 = await db2.pp.upsertBy("name", { name: "v", q: 2 });
    expect(u2.id).toBe(u1.id);
    expect(u2.q).toBe(2);
    expect((await db2.pp.byUnique("name", { name: "v" }))?.q).toBe(2);
    await Promise.all(Array.from({ length: 8 }, (_, i) => db2.pp.upsertBy("name", { name: "w", q: i })));
    expect((await db2.pp.all()).filter((r) => r.name === "w")).toHaveLength(1);
    expect(a.name).toBe("x");
  });

  it("rejects unknown columns and nulls in not-null columns", async () => {
    await expect(db.items.insert({ id: "z", group: null as never })).rejects.toThrow(/not-null/);
    await expect(db.items.insert({ id: "z", group: "g", nope: 1 } as never)).rejects.toThrow(/unknown column/);
    await db.items.insert({ id: "z", group: "g" });
    await expect(db.items.update("z", { group: null as never })).rejects.toThrow(/not-null/);
  });
});

describe("memory backend file persistence", () => {
  it("saves on close and loads on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmstore-"));
    try {
      const file = join(dir, "s.json");
      const a = memoryBackend({ file });
      const db = createStore(a, tables);
      await db.items.insert({ id: "a", group: "g", score: -Infinity });
      await db.logs.insert({ item: "a", n: 1 });
      await a.close();
      const db2 = createStore(memoryBackend({ file }), tables);
      expect((await db2.items.get("a"))?.score).toBe(-Infinity);
      expect(await db2.items.ids("byScore", {})).toEqual(["a"]);
      expect((await db2.logs.insert({ item: "a", n: 2 })).id).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

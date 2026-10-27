import { beforeAll, expect, it } from "vitest";
import { getDb, insertSnapshots, migrate, pruneScreens, pruneSnapshots, schema as s } from "./index";

beforeAll(async () => {
  process.env.PGLITE_DIR = "memory://";
  await migrate();
}, 60_000);

it("keeps latest per market; recent history only for watched; deletes the rest", async () => {
  const db = getDb(), now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000);
  await insertSnapshots(db, [
    { conditionId: "w", ts: d(20), mid: 1 }, { conditionId: "w", ts: d(3), mid: 2 }, { conditionId: "w", ts: d(1), mid: 3 }, // watched: old deleted, recent kept
    { conditionId: "u", ts: d(20), mid: 4 }, { conditionId: "u", ts: d(3), mid: 5 }, { conditionId: "u", ts: d(1), mid: 6 }, // unwatched: latest only
    { conditionId: "s", ts: d(30), mid: 7 }, { conditionId: "s", ts: d(9), mid: 8 }, // stale: latest kept
  ]);
  await pruneSnapshots(db, ["w"], now);
  expect((await db.select().from(s.snapshots)).map((r) => r.mid).sort()).toEqual([2, 3, 6, 8]);
});

it("prunes screen runs older than the window, keeping the newest row per market", async () => {
  const db = getDb(), now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000);
  await db.insert(s.screens).values([
    { conditionId: "a", ts: d(5) }, { conditionId: "a", ts: d(3) }, { conditionId: "a", ts: d(1) }, // old runs go, recent kept
    { conditionId: "b", ts: d(6) }, { conditionId: "b", ts: d(4) }, // dropped out of the screen: newest kept
  ]);
  await pruneScreens(db, now);
  expect((await db.select().from(s.screens)).map((r) => `${r.conditionId}${Math.round((now - r.ts.getTime()) / 86_400_000)}`).sort()).toEqual(["a1", "b4"]);
});

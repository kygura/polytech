import { beforeAll, expect, it } from "vitest";
import { getDb, insertSnapshots, migrate, pruneSnapshots, schema as s } from "./index";

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

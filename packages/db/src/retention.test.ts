import { beforeEach, expect, it } from "vitest";
import { getDb, insertSnapshots, pruneMarkets, pruneScreens, pruneSnapshots, referencedMarkets } from "./index";

beforeEach(() => getDb().flush());

it("keeps latest per market; recent history only for watched; deletes the rest", async () => {
  const db = getDb(), now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000);
  await insertSnapshots(db, [
    { conditionId: "w", ts: d(20), mid: 1 }, { conditionId: "w", ts: d(3), mid: 2 }, { conditionId: "w", ts: d(1), mid: 3 }, // watched: old deleted, recent kept
    { conditionId: "u", ts: d(20), mid: 4 }, { conditionId: "u", ts: d(3), mid: 5 }, { conditionId: "u", ts: d(1), mid: 6 }, // unwatched: latest only
    { conditionId: "s", ts: d(30), mid: 7 }, { conditionId: "s", ts: d(9), mid: 8 }, // stale: latest kept
  ]);
  await pruneSnapshots(db, ["w"], now);
  expect((await db.snapshots.all()).map((r) => r.mid).sort()).toEqual([2, 3, 6, 8]);
  await pruneSnapshots(db, [], now); // nothing watched: latest per market only
  expect((await db.snapshots.all()).map((r) => r.mid).sort()).toEqual([3, 6, 8]);
});

it("prunes screen runs older than the window, keeping the newest row per market", async () => {
  const db = getDb(), now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000);
  await db.screens.insertMany([
    { conditionId: "a", ts: d(5) }, { conditionId: "a", ts: d(3) }, { conditionId: "a", ts: d(1) }, // old runs go, recent kept
    { conditionId: "b", ts: d(6) }, { conditionId: "b", ts: d(4) }, // dropped out of the screen: newest kept
  ]);
  await pruneScreens(db, now);
  expect((await db.screens.all()).map((r) => `${r.conditionId}${Math.round((now - r.ts.getTime()) / 86_400_000)}`).sort()).toEqual(["a1", "b4"]);
});

it("prunes markets outside the kept set with their latest, history and screen rows; referenced markets are listed", async () => {
  const db = getDb(), now = new Date();
  const mk = (c: string) => ({ conditionId: c, question: c });
  await db.markets.insertMany([mk("keep"), mk("drop"), mk("held")]);
  await db.marketLatest.insertMany([{ conditionId: "keep" }, { conditionId: "drop" }]);
  await insertSnapshots(db, [{ conditionId: "keep", ts: now }, { conditionId: "drop", ts: now }]);
  await db.screens.insertMany([{ conditionId: "keep", ts: now }, { conditionId: "drop", ts: now }]);
  await db.positions.insert({ conditionId: "held", tokenId: "t", size: 1, avgCost: 0.5 });
  const ref = await referencedMarkets(db);
  expect(ref.has("held")).toBe(true);
  await pruneMarkets(db, ["keep", ...ref]);
  const ids = async (t: "markets" | "marketLatest" | "snapshots" | "screens") =>
    (await db[t].all()).map((r) => r.conditionId).filter((c) => ["keep", "drop", "held"].includes(c)).sort();
  expect(await ids("markets")).toEqual(["held", "keep"]);
  expect(await ids("marketLatest")).toEqual(["keep"]);
  expect(await ids("snapshots")).toEqual(["keep"]);
  expect(await ids("screens")).toEqual(["keep"]);
  await pruneMarkets(db, []); // empty keep: a no-op, never a wipe
  expect(await ids("markets")).toEqual(["held", "keep"]);
});

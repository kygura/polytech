import { describe, expect, it } from "vitest";
import { createStore, memoryBackend, tables, type Backend } from "./index";
import { reindex } from "./maintenance";
import type { Db } from "./client";

describe("reindex", () => {
  it("rebuilds dropped entries, and never indexes a row from a stale scan", async () => {
    const b = memoryBackend();
    const db = createStore(b, tables) as Db;
    const p = { thesisId: "t1", conditionId: "c1", tokenId: "tok", side: "BUY", kind: "entry", sizeUsd: 1, shares: 1, limitPrice: 0.5, expectedProfit: 0, priceAtProposal: 0.5, expiresAt: new Date(), approveTokenHash: "a", rejectTokenHash: "r" };
    const row = await db.proposals.insert(p);
    const stale = await b.scan("proposals"); // scan taken while the proposal is pending
    await db.proposals.update(row.id, { status: "approved" });
    const lagging: Backend = { ...b, scan: async (t) => (t === "proposals" ? stale : b.scan(t)) };
    await reindex(createStore(lagging, tables) as Db, ["proposals"]);
    expect(await db.proposals.ids("status", { status: "pending" })).toEqual([]); // the stale 'pending' entry was not written back
    expect(await db.proposals.ids("status", { status: "approved" })).toEqual([row.id]);
    // a fresh pending proposal for the same thesis is still allowed: no stale unique claim either
    await db.proposals.insert(p);
  });
});

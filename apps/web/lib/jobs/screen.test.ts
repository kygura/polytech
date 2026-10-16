import { describe, expect, it } from "vitest";
import { detectStructural } from "./screen";

type Rows = Parameters<typeof detectStructural>[0];
const row = (id: string, o: { q?: string; end?: number; group?: string; bid: number; ask: number }) => ({
  m: { conditionId: id, eventId: id, question: o.q ?? `Will ${id} happen`, rules: "", category: "other", tags: [], endDate: o.end ?? Date.parse("2027-01-01"), negRiskGroup: o.group ?? null, feeRate: 0 },
  snap: { mid: (o.bid + o.ask) / 2, book: { bids: [{ price: o.bid, size: 1000 }], asks: [{ price: o.ask, size: 1000 }] } },
}) as unknown as Rows[number];

describe("detectStructural", () => {
  const negs = [row("a", { group: "g", bid: 0.25, ask: 0.3 }), row("b", { group: "g", bid: 0.25, ask: 0.3 })];
  it("neg-risk buy-all needs every leg of the group present", () => {
    expect(detectStructural(negs, 50, new Map([["g", 3]])).size).toBe(0);
    expect(detectStructural(negs, 50, new Map([["g", 2]])).get("a")).toMatchObject({ kind: "buy-all" });
  });
  const ladder = (earlyBid: number, earlyAsk: number, lateBid: number, lateAsk: number) => [
    row("e", { q: "Will X happen by June 1", end: Date.parse("2027-06-01"), bid: earlyBid, ask: earlyAsk }),
    row("l", { q: "Will X happen by July 1", end: Date.parse("2027-07-01"), bid: lateBid, ask: lateAsk }),
  ];
  it("ladder claimed only with positive locked edge", () => {
    expect(detectStructural(ladder(0.58, 0.62, 0.48, 0.52), 50).get("e")?.lockedC).toBeGreaterThan(0);
    expect(detectStructural(ladder(0.5, 0.7, 0.3, 0.7), 50).size).toBe(0); // bid 0.50 < ask 0.70
  });
  it("mirror needs same end date", () => {
    const mk = (end2: number) => [
      row("m1", { q: "Will Federal Data Privacy Act pass", bid: 0.6, ask: 0.62 }),
      row("m2", { q: "Will Federal Data Privacy Act pass", end: end2, bid: 0.4, ask: 0.42 }),
    ];
    expect(detectStructural(mk(Date.parse("2027-01-01")), 50).get("m1")).toMatchObject({ type: "mirror" });
    expect(detectStructural(mk(Date.parse("2028-01-01")), 50).size).toBe(0);
  });
});

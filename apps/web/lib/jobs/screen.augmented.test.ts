import { describe, expect, it } from "vitest";
import { detectStructural } from "./screen";

type Rows = Parameters<typeof detectStructural>[0];
const leg = (id: string, augmented: boolean) => ({
  m: { conditionId: id, eventId: "e", question: `Will ${id} win`, rules: "", category: "other", tags: [], endDate: Date.parse("2027-01-01"), negRiskGroup: "g", negRiskAugmented: augmented, feeRate: 0 },
  snap: { mid: 0.275, book: { bids: [{ price: 0.25, size: 1000 }], asks: [{ price: 0.3, size: 1000 }] } },
}) as unknown as Rows[number];

describe("detectStructural: augmented neg-risk events", () => {
  const legs = (aug: boolean) => [leg("a", aug), leg("b", aug), leg("c", aug)];
  it("Σasks < 1 over a complete, non-augmented group is a buy-all lock; an augmented event (it can still gain an outcome) is not", () => {
    const sizes = new Map([["g", 3]]);
    expect(detectStructural(legs(false), 50, sizes).get("a")).toMatchObject({ kind: "buy-all" });
    expect(detectStructural(legs(true), 50, sizes).size).toBe(0);
    const kinds = new Map();
    detectStructural(legs(true), 50, sizes, kinds);
    expect(kinds.size).toBe(0);
  });
});

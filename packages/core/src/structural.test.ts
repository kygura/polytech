import { describe, expect, it } from "vitest";
import { ladderViolations, mirrorPairs, negRiskArb } from "./structural";

const lv = (price: number) => [{ price, size: 100 }];
const leg = (id: string, bid: number, ask: number) => ({ conditionId: id, bids: lv(bid), asks: lv(ask) });

describe("negRiskArb", () => {
  it("buy-all when sum of fee-adjusted asks < 1", () => {
    // each .30 + .04*.30*.70 = .3084 ; sum .9252
    const r = negRiskArb([leg("a", 0.2, 0.3), leg("b", 0.2, 0.3), leg("c", 0.2, 0.3)], 0.04)!;
    expect(r.kind).toBe("buy-all");
    expect(r.edge).toBeCloseTo(1 - 0.9252, 12);
  });
  it("sell-all when sum of fee-adjusted bids > 1", () => {
    // .4-.04*.24=.3904 ; .35-.04*.2275=.3409 ; .3-.04*.21=.2916 ; sum 1.0229
    const r = negRiskArb([leg("a", 0.4, 0.9), leg("b", 0.35, 0.9), leg("c", 0.3, 0.9)], 0.04)!;
    expect(r.kind).toBe("sell-all");
    expect(r.edge).toBeCloseTo(0.0229, 12);
  });
  it("fees can erase an apparent arb", () => {
    // sum of asks .99 but fees .04*(.33*.67)*3 = .0265 -> cost 1.0165
    expect(negRiskArb([leg("a", 0.2, 0.33), leg("b", 0.2, 0.33), leg("c", 0.2, 0.33)], 0.04)).toBeNull();
  });
  it("null when fair, under 2 legs, or a leg lacks a book", () => {
    expect(negRiskArb([leg("a", 0.3, 0.35), leg("b", 0.3, 0.35), leg("c", 0.3, 0.35)], 0.04)).toBeNull();
    expect(negRiskArb([leg("a", 0.2, 0.3)], 0)).toBeNull();
    expect(negRiskArb([leg("a", 0.2, 0.3), { conditionId: "b", bids: [], asks: [] }], 0)).toBeNull();
  });
});

describe("ladderViolations", () => {
  it("flags an earlier date priced above a later one", () => {
    const v = ladderViolations([
      { conditionId: "jun", date: 2, p: 0.3 },
      { conditionId: "mar", date: 1, p: 0.4 },
      { conditionId: "dec", date: 3, p: 0.5 },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.earlier).toBe("mar");
    expect(v[0]!.later).toBe("jun");
    expect(v[0]!.gap).toBeCloseTo(0.1, 12);
  });
  it("monotone ladder and ties are clean; tolerance respected", () => {
    expect(ladderViolations([{ conditionId: "a", date: 1, p: 0.3 }, { conditionId: "b", date: 2, p: 0.3 }])).toEqual([]);
    expect(ladderViolations([{ conditionId: "a", date: 1, p: 0.32 }, { conditionId: "b", date: 2, p: 0.3 }], 0.05)).toEqual([]);
  });
});

describe("mirrorPairs", () => {
  it("same normalized question, price diff above threshold", () => {
    const r = mirrorPairs([
      { conditionId: "a", question: "Will X win?", p: 0.5 },
      { conditionId: "b", question: "  will x WIN ", p: 0.58 },
      { conditionId: "c", question: "Will Y win?", p: 0.1 },
    ], 0.03);
    expect(r).toHaveLength(1);
    expect(r[0]!.a).toBe("a");
    expect(r[0]!.b).toBe("b");
    expect(r[0]!.diff).toBeCloseTo(0.08, 12);
  });
  it("close prices are not flagged", () => {
    expect(mirrorPairs([
      { conditionId: "a", question: "Q?", p: 0.5 }, { conditionId: "b", question: "Q?", p: 0.51 },
    ], 0.03)).toEqual([]);
  });
});

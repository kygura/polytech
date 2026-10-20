import { describe, expect, it } from "vitest";
import { findStructural, mirrorPairs, parseLadderKey, structuralFlagsByMarket, type StructuralGroup } from "./structural";

type M = StructuralGroup["markets"][number];
const mk = (id: string, question: string, o: Partial<M> = {}): M => ({
  conditionId: id, question, endDate: null, bestBid: null, bestAsk: null, mid: null, ...o,
});
const grp = (markets: M[], o: Partial<StructuralGroup> = {}): StructuralGroup => ({
  eventId: "e1", eventTitle: "Event", negRisk: false, markets, ...o,
});
const px = (id: string, q: string, mid: number, half = 0.005, o: Partial<M> = {}): M => mk(id, q, { mid, bestBid: mid - half, bestAsk: mid + half, ...o });
const D = (s: string) => Date.parse(s);

describe("parseLadderKey", () => {
  it("dates", () => {
    const a = parseLadderKey("Will X happen by June 30, 2026?")!;
    const b = parseLadderKey("Will X happen by December 31, 2026?")!;
    expect(a.kind).toBe("date");
    expect(b.value).toBeGreaterThan(a.value);
    expect(a.stem).toBe(b.stem);
    expect(a).toMatchObject({ decreasing: false });
    expect(parseLadderKey("Will the ceasefire continue through October 22?")).toMatchObject({ decreasing: true });
    expect(parseLadderKey("Will X remain in office until June 30, 2026?")).toMatchObject({ decreasing: true });
    expect(parseLadderKey("Will X stay above 5 by June 30?")).toMatchObject({ decreasing: true });
    expect(parseLadderKey("Will X happen by Dec 31?", 2026)!.value).toBe(Date.UTC(2026, 11, 31));
    expect(parseLadderKey("Will X happen by end of March 2027?")!.value).toBe(Date.UTC(2027, 2, 31));
    expect(parseLadderKey("Will X happen by June?", 2026)!.value).toBe(Date.UTC(2026, 5, 30));
    expect(parseLadderKey("Will X happen before 2027?")!.value).toBe(Date.UTC(2026, 11, 31));
    expect(parseLadderKey("Will X happen before March 2027?")!.value).toBe(Date.UTC(2027, 1, 28));
    expect(parseLadderKey("Will X happen before June 1, 2026?")!.value).toBe(Date.UTC(2026, 4, 31));
    expect(parseLadderKey("Will X happen before June 30, 2026?")!.value).toBe(Date.UTC(2026, 5, 29));
    expect(parseLadderKey("Will X happen by March 2027?")!.value).toBe(Date.UTC(2027, 2, 31));
    expect(parseLadderKey("Will X happen by May 5th, 2026?")!.value).toBe(Date.UTC(2026, 4, 5));
  });
  it("thresholds", () => {
    const a = parseLadderKey("Will Bitcoin be above $100,000 on Friday?")!;
    expect(a).toMatchObject({ kind: "threshold", value: 100000, dir: "above" });
    expect(parseLadderKey("Will BTC reach $1.5m (HIGH)?")).toMatchObject({ kind: "threshold", value: 1_500_000, dir: "above" });
    expect(parseLadderKey("Will BTC reach $1.5m?")).toBeNull(); // direction-ambiguous
    expect(parseLadderKey("Will CPI be below 3.1%?")).toMatchObject({ kind: "threshold", value: 3.1, dir: "below" });
    expect(parseLadderKey("Will ETH be ≥ 5k?")).toMatchObject({ value: 5000, dir: "above" });
    expect(parseLadderKey("Will X be above $100k?")!.stem).toBe(parseLadderKey("Will X be above $200k?")!.stem);
    expect(parseLadderKey("Will X be above $100k?")!.stem).not.toBe(parseLadderKey("Will X be below $100k?")!.stem);
  });
  it("none", () => {
    expect(parseLadderKey("Will Trump win the 2028 election?")).toBeNull();
    expect(parseLadderKey("")).toBeNull();
  });
});

describe("overround", () => {
  it("negRisk underround: sum asks < 1", () => {
    const g = grp([px("a", "A wins?", 0.3), px("b", "B wins?", 0.3), px("c", "C wins?", 0.3)], { negRisk: true });
    const items = findStructural([g]);
    const o = items.find((i) => i.kind === "overround")!;
    expect(o).toBeDefined();
    expect([...o.conditionIds].sort()).toEqual(["a", "b", "c"]);
    expect(o.magnitude).toBeCloseTo(1 - 3 * 0.305, 9);
    expect(o.net).toBeCloseTo(1 - 3 * 0.305 - 3 * 0.04 * 0.305 * 0.695, 9);
    expect(o.side).toBe("ask");
    expect(o.eventId).toBe("e1");
    expect(o.description).toContain("asks");
  });
  it("negRisk overround: sum bids > 1", () => {
    const g = grp([px("a", "A?", 0.4), px("b", "B?", 0.4), px("c", "C?", 0.3)], { negRisk: true });
    const o = findStructural([g]).find((i) => i.kind === "overround")!;
    expect(o.magnitude).toBeCloseTo(0.395 + 0.395 + 0.295 - 1, 9);
    expect(o.side).toBe("bid");
    expect(o.description).toContain("bids");
  });
  it("within tolerance -> nothing", () => {
    const g = grp([px("a", "A?", 0.5, 0.005), px("b", "B?", 0.5, 0.005)], { negRisk: true });
    expect(findStructural([g])).toEqual([]);
  });
  it("non-negRisk groups are not checked", () => {
    const g = grp([px("a", "A?", 0.3), px("b", "B?", 0.3), px("c", "C?", 0.3)]);
    expect(findStructural([g]).filter((i) => i.kind === "overround")).toEqual([]);
  });
  it("missing asks -> ask side skipped; single market skipped", () => {
    const g = grp([mk("a", "A?", { bestBid: 0.3, mid: 0.3 }), px("b", "B?", 0.3), px("c", "C?", 0.3)], { negRisk: true });
    expect(findStructural([g]).filter((i) => i.kind === "overround")).toEqual([]);
    expect(findStructural([grp([px("a", "A?", 0.3)], { negRisk: true })])).toEqual([]);
  });
  it("custom tolerance", () => {
    const g = grp([px("a", "A?", 0.45), px("b", "B?", 0.45)], { negRisk: true });
    expect(findStructural([g]).length).toBeGreaterThan(0);
    expect(findStructural([g], { overroundTolerance: 0.2, siblingTolerance: 0.2 })).toEqual([]);
  });
});

describe("overround: fees, incomplete events, sizes", () => {
  const three = (o: Partial<StructuralGroup> = {}, m: Partial<M> = {}) =>
    grp([px("a", "A?", 0.3), px("b", "B?", 0.3), px("c", "C?", 0.3)].map((x) => ({ ...x, ...m })), { negRisk: true, ...o });
  it("augmented / inactive-market events skip the Σasks<1 lock", () => {
    expect(findStructural([three({ negRiskAugmented: true })])).toEqual([]);
    expect(findStructural([three({ hasInactiveMarkets: true })])).toEqual([]);
  });
  it("Σbids>1 still flagged on augmented events", () => {
    const g = grp([px("a", "A?", 0.4), px("b", "B?", 0.4), px("c", "C?", 0.3)], { negRisk: true, negRiskAugmented: true });
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["overround"]);
  });
  it("taker fees are subtracted from the gap", () => {
    // asks sum .96: gap .04 > tol .01 but fees 3*.04*.32*.68 = .026 -> .036 < .04 flagged; with higher fee not flagged
    const g = grp([0, 1, 2].map((i) => mk(`m${i}`, `T${i}?`, { bestBid: 0.31, bestAsk: 0.32, mid: 0.315 })), { negRisk: true });
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["overround"]);
    const pricey = grp(g.markets.map((m) => ({ ...m, feeRate: 0.1 })), { negRisk: true });
    expect(findStructural([pricey]).filter((i) => i.kind === "overround")).toEqual([]);
    const free = grp(g.markets.map((m) => ({ ...m, feeRate: 0 })), { negRisk: true });
    expect(findStructural([free]).map((i) => i.kind)).toEqual(["overround"]);
    expect(findStructural([free])[0]!.net).toBeCloseTo(0.04, 9);
  });
  it("thin best-ask size blocks the basket", () => {
    expect(findStructural([three({}, { askSize: 10 })])).toEqual([]);
    expect(findStructural([three({}, { askSize: 500 })]).map((i) => i.kind)).toEqual(["overround"]);
    expect(findStructural([three({}, { askSize: 10 })], { minTicket: 5 }).map((i) => i.kind)).toEqual(["overround"]);
  });
});

describe("sibling_inconsistency", () => {
  it("mid-only deviation is spread noise: never reported", () => {
    const g = grp([mk("a", "A?", { mid: 0.4 }), mk("b", "B?", { mid: 0.4 }), mk("c", "C?", { mid: 0.4 })], { negRisk: true });
    expect(findStructural([g])).toEqual([]);
  });
  it("wide spreads inflate mids but nothing is executable", () => {
    const g = grp([0, 1, 2].map((i) => mk(`m${i}`, `T${i}?`, { bestBid: 0.267, bestAsk: 0.433, mid: 0.35 })), { negRisk: true });
    expect(findStructural([g])).toEqual([]);
  });
  it("executable before fees but not after fees -> nothing", () => {
    const g = grp([0, 1, 2].map((i) => mk(`m${i}`, `T${i}?`, { bestBid: 0.335, bestAsk: 0.385, mid: 0.36 })), { negRisk: true });
    expect(findStructural([g])).toEqual([]); // bids sum 1.005: gap .005 < fees
  });
  it("sibling only when executable after fees but inside the overround band", () => {
    // bids .3455 x3 = 1.0365, fees ~.0271 -> net +.0094 (< tol .01 + fees), mids sum 1.0665
    const g = grp([0, 1, 2].map((i) => mk(`m${i}`, `T${i}?`, { bestBid: 0.3455, bestAsk: 0.3655, mid: 0.3555 })), { negRisk: true });
    const items = findStructural([g]);
    expect(items.map((i) => i.kind)).toEqual(["sibling_inconsistency"]);
    expect(items[0]!.description).toContain("after fees");
    expect(items[0]!.side).toBe("bid");
    expect(items[0]!.net).toBeGreaterThan(0);
  });
  it("no duplicate when overround already flags", () => {
    const g = grp([px("a", "A?", 0.4), px("b", "B?", 0.4), px("c", "C?", 0.4)], { negRisk: true });
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["overround"]);
  });
  it("sum near 1 or unknown mids -> none; augmented skipped", () => {
    expect(findStructural([grp([mk("a", "A?", { mid: 0.52 }), mk("b", "B?", { mid: 0.5 })], { negRisk: true })])).toEqual([]);
    expect(findStructural([grp([mk("a", "A?", { mid: 0.9 }), mk("b", "B?")], { negRisk: true })])).toEqual([]);
    const g = grp([0, 1, 2].map((i) => mk(`m${i}`, `T${i}?`, { bestBid: 0.267, bestAsk: 0.3, mid: 0.4 })), { negRisk: true, negRiskAugmented: true });
    expect(findStructural([g])).toEqual([]);
  });
});

describe("monotonicity_violation", () => {
  it("date ladder: later deadline priced below earlier", () => {
    const g = grp([
      px("dec", "Will X happen by December 31, 2026?", 0.3),
      px("jun", "Will X happen by June 30, 2026?", 0.4),
      px("sep", "Will X happen by September 30, 2026?", 0.45),
    ]);
    const items = findStructural([g]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("monotonicity_violation");
    expect(items[0]!.conditionIds).toEqual(["sep", "dec"]);
    expect(items[0]!.magnitude).toBeCloseTo(0.14, 9);
    expect(items[0]!.net).toBeCloseTo(0.14 - 0.04 * 0.445 * 0.555 - 0.04 * 0.305 * 0.695, 9); // sell sep at its bid, buy dec at its ask
  });
  it("consistent ladder -> none; tolerance respected", () => {
    const ok = grp([px("a", "Will X by June 30, 2026?", 0.3), px("b", "Will X by December 31, 2026?", 0.4)]);
    expect(findStructural([ok])).toEqual([]);
    const tiny = grp([px("a", "Will X by June 30, 2026?", 0.305), px("b", "Will X by December 31, 2026?", 0.3)]);
    expect(findStructural([tiny])).toEqual([]);
  });
  it("different stems are separate ladders", () => {
    const g = grp([px("a", "Will X happen by June 30, 2026?", 0.5), px("b", "Will Y happen by December 31, 2026?", 0.2)]);
    expect(findStructural([g])).toEqual([]);
  });
  it("year from endDate reference when question omits it", () => {
    const g = grp([
      px("a", "Will X happen by June 30?", 0.2, 0.005),
      px("b", "Will X happen by December 31?", 0.1, 0.005),
    ].map((m, i) => ({ ...m, endDate: D(i === 0 ? "2026-06-30T00:00:00Z" : "2026-12-31T00:00:00Z") })));
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
  });
  it("threshold 'above' ladder must decrease", () => {
    const g = grp([
      px("a", "Will BTC be above $100k on Dec 31?", 0.4),
      px("b", "Will BTC be above $110k on Dec 31?", 0.5),
      px("c", "Will BTC be above $120k on Dec 31?", 0.2),
    ]);
    const items = findStructural([g]).filter((i) => i.kind === "monotonicity_violation");
    expect(items).toHaveLength(1);
    expect(items[0]!.conditionIds).toEqual(["a", "b"]);
    expect(items[0]!.magnitude).toBeCloseTo(0.09, 9);
  });
  it("threshold 'below' ladder must increase", () => {
    const g = grp([px("a", "Will CPI be below 3.0%?", 0.5), px("b", "Will CPI be below 3.5%?", 0.4)]);
    const items = findStructural([g]);
    expect(items).toHaveLength(1);
    expect(items[0]!.conditionIds).toEqual(["a", "b"]);
  });
  it("explicit threshold field", () => {
    const g = grp([
      { ...px("a", "Highest temperature in NYC above 90", 0.3), threshold: 90 },
      { ...px("b", "Highest temperature in NYC above 95", 0.5), threshold: 95 },
    ]);
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
    const amb = grp([
      { ...px("a", "Highest temperature in NYC hits 90", 0.3), threshold: 90 },
      { ...px("b", "Highest temperature in NYC hits 95", 0.5), threshold: 95 },
    ]);
    expect(findStructural([amb])).toEqual([]);
  });
  it("markets without quotes skipped, never NaN; mid-only is not executable", () => {
    const g = grp([mk("a", "Will X by June 30, 2026?"), px("b", "Will X by December 31, 2026?", 0.4)]);
    expect(findStructural([g])).toEqual([]);
    const midOnly = grp([mk("a", "Will X by June 30, 2026?", { mid: 0.5 }), mk("b", "Will X by December 31, 2026?", { mid: 0.3 })]);
    expect(findStructural([midOnly])).toEqual([]);
  });
  it("spread-crossing 'violation' is not executable", () => {
    const g = grp([
      mk("a", "Will X by June 30, 2026?", { bestBid: 0.38, bestAsk: 0.42, mid: 0.4 }),
      mk("b", "Will X by December 31, 2026?", { bestBid: 0.37, bestAsk: 0.42, mid: 0.395 }),
    ]);
    expect(findStructural([g])).toEqual([]);
  });
  it("'continues through <date>' ladders decrease with date", () => {
    const g = grp([
      px("oct", "US-Iran ceasefire continues through October 22?", 0.93, 0.005, { endDate: D("2026-10-22T00:00:00Z") }),
      px("nov", "US-Iran ceasefire continues through November 30?", 0.6, 0.005, { endDate: D("2026-11-30T00:00:00Z") }),
      px("dec", "US-Iran ceasefire continues through December 31?", 0.345, 0.005, { endDate: D("2026-12-31T00:00:00Z") }),
    ]);
    expect(findStructural([g])).toEqual([]);
    const bad = grp([
      px("oct", "US-Iran ceasefire continues through October 22?", 0.5, 0.005, { endDate: D("2026-10-22T00:00:00Z") }),
      px("dec", "US-Iran ceasefire continues through December 31?", 0.6, 0.005, { endDate: D("2026-12-31T00:00:00Z") }),
    ]);
    const items = findStructural([bad]);
    expect(items).toHaveLength(1);
    expect(items[0]!.conditionIds).toEqual(["oct", "dec"]);
    expect(items[0]!.magnitude).toBeCloseTo(0.595 - 0.505, 9);
    const until = grp([px("a", "Will X remain in office until June 30, 2026?", 0.9), px("b", "Will X remain in office until December 31, 2026?", 0.5)]);
    expect(findStructural([until])).toEqual([]);
  });
});

describe("live false positives (A-D)", () => {
  const ou = (id: string, n: string, mid: number, o: Partial<M> = {}) =>
    px(id, `Map 2 Total Rounds: Over/Under ${n}`, mid, 0.005, { outcomes: ["Over", "Under"], ...o });
  it("A. Over/Under ladders: YES=Over decreases with the line", () => {
    expect(findStructural([grp([ou("a", "21.5", 0.99), ou("b", "24.5", 0.01)])])).toEqual([]);
    expect(findStructural([grp([ou("a", "21.5", 0.99), ou("b", "24.5", 0.01)].map(({ outcomes: _o, ...m }) => m))])).toEqual([]);
    expect(parseLadderKey("Total Kills O/U 22.5")).toMatchObject({ kind: "threshold", dir: "above", value: 22.5 });
    const bad = findStructural([grp([ou("a", "21.5", 0.3), ou("b", "24.5", 0.6)])]);
    expect(bad.map((i) => i.kind)).toEqual(["monotonicity_violation"]);
    const under = (id: string, n: string, mid: number) => ou(id, n, mid, { outcomes: ["Under", "Over"] });
    expect(findStructural([grp([under("a", "21.5", 0.01), under("b", "24.5", 0.99)])])).toEqual([]);
    expect(findStructural([grp([under("a", "21.5", 0.9), under("b", "24.5", 0.2)])]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
  });
  it("B. (LOW) ladders are downside ladders; (HIGH) upside; plain hit/reach skipped", () => {
    const low = (id: string, x: string, bid: number, ask: number) =>
      mk(id, `Will S&P 500 (SPX) hit ${x} (LOW) in December?`, { bestBid: bid, bestAsk: ask, mid: (bid + ask) / 2 });
    expect(findStructural([grp([low("hi", "$7,400", 0.47, 0.49), low("lo", "$4,500", 0.012, 0.017)])])).toEqual([]);
    expect(parseLadderKey("Will S&P 500 (SPX) hit $7,400 (LOW) in December?")).toMatchObject({ dir: "below", value: 7400 });
    expect(parseLadderKey("Will S&P 500 (SPX) hit $7,400 (HIGH) in December?")).toMatchObject({ dir: "above", value: 7400 });
    expect(findStructural([grp([low("hi", "$7,400", 0.2, 0.22), low("lo", "$4,500", 0.5, 0.52)])]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
    const high = (id: string, x: string, bid: number, ask: number) =>
      mk(id, `Will S&P 500 (SPX) hit ${x} (HIGH) in December?`, { bestBid: bid, bestAsk: ask, mid: (bid + ask) / 2 });
    expect(findStructural([grp([high("lo", "$7,000", 0.6, 0.62), high("hi", "$8,000", 0.1, 0.12)])])).toEqual([]);
    const appr = (id: string, x: string, bid: number, ask: number) =>
      mk(id, `Will Trump's approval rating hit ${x}% by June 30, 2027?`, { bestBid: bid, bestAsk: ask, mid: (bid + ask) / 2, endDate: D("2027-06-30T00:00:00Z") });
    expect(findStructural([grp([appr("a", "37", 0.3, 0.32), appr("b", "30", 0.1, 0.12)])])).toEqual([]);
    expect(findStructural([grp([appr("a", "37", 0.1, 0.12), appr("b", "30", 0.3, 0.32)])])).toEqual([]);
  });
  it("C. range buckets and exact counts are not ladders", () => {
    const q = (id: string, t: string, mid: number) => px(id, t, mid);
    expect(parseLadderKey("Will The Joint List win 6.5-7.5% of the vote?")).toBeNull();
    expect(parseLadderKey("Will CPI be between 3.0% and 3.5%?")).toBeNull();
    expect(parseLadderKey("Will Democrats win exactly 1 House seat in Tennessee?")).toBeNull();
    expect(findStructural([grp([q("a", "Will Democrats win exactly 1 House seat in Tennessee?", 0.2), q("b", "Will Democrats win exactly 0 House seats in Tennessee?", 0.7)])])).toEqual([]);
    expect(findStructural([grp([q("a", "Will The Joint List win 6.5-7.5% of the vote?", 0.1), q("b", "Will The Joint List win 7.5-8.5% of the vote?", 0.5)])])).toEqual([]);
    expect(parseLadderKey("Will The Joint List win 7.5% or more of the vote?")).toMatchObject({ dir: "above", value: 7.5 });
    expect(parseLadderKey("Will unemployment be 4% or less?")).toMatchObject({ dir: "below", value: 4 });
    const g = grp([q("a", "Will The Joint List win 7.5% or more of the vote?", 0.2), q("b", "Will The Joint List win 8.5% or more of the vote?", 0.6)]);
    expect(findStructural([g]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
    expect(parseLadderKey("Will BTC be above $100k on 2026-12-31?")).toMatchObject({ value: 100000, dir: "above" });
  });
  it("D. yearless dates use each market's own endDate year", () => {
    const d = (id: string, t: string, mid: number, end: string) => px(id, t, mid, 0.005, { endDate: D(end) });
    const tate = grp([
      d("jun", "Andrew Tate Extradited to UK by Jun 30?", 0.05, "2027-06-30T00:00:00Z"),
      d("dec", "Andrew Tate Extradited to UK by Dec 31?", 0.02, "2026-12-31T00:00:00Z"),
    ]);
    expect(findStructural([tate])).toEqual([]);
    const tesla = grp([
      d("jun", "Tesla and SpaceX merger officially announced by June 30, 2027?", 0.3, "2027-06-30T00:00:00Z"),
      d("dec", "Tesla and SpaceX merger officially announced by December 31?", 0.35, "2027-12-31T00:00:00Z"),
    ]);
    expect(findStructural([tesla])).toEqual([]);
    const ath = grp([
      d("mar", "Will Crude Oil reach a new all-time high by March 31, 2027?", 0.2, "2027-03-31T00:00:00Z"),
      d("dec", "Will Crude Oil reach a new all-time high by December 31?", 0.1, "2026-12-31T00:00:00Z"),
    ]);
    expect(findStructural([ath])).toEqual([]);
    const bad = grp([
      d("jun", "Andrew Tate Extradited to UK by Jun 30?", 0.05, "2026-06-30T00:00:00Z"),
      d("dec", "Andrew Tate Extradited to UK by Dec 31?", 0.02, "2026-12-31T00:00:00Z"),
    ]);
    expect(findStructural([bad]).map((i) => i.kind)).toEqual(["monotonicity_violation"]);
    expect(findStructural([grp([px("a", "Will X by Jun 30?", 0.5), px("b", "Will X by Dec 31?", 0.1)])])).toEqual([]);
    expect(parseLadderKey("Will X by Jun 30?", undefined, { endDate: D("2027-06-30T00:00:00Z") })!.value).toBe(Date.UTC(2027, 5, 30));
    expect(parseLadderKey("Will X by Jun 30?", undefined, { endDate: D("2027-07-01T00:00:00Z") })!.value).toBe(Date.UTC(2027, 6, 1));
  });
});

describe("misc", () => {
  it("empty input; sorted by magnitude desc", () => {
    expect(findStructural([])).toEqual([]);
    const g1 = grp([px("a", "A?", 0.3), px("b", "B?", 0.3), px("c", "C?", 0.3)], { negRisk: true, eventId: "e1" });
    const g2 = grp([px("d", "D?", 0.2), px("e", "E?", 0.2), px("f", "F?", 0.2)], { negRisk: true, eventId: "e2" });
    const items = findStructural([g1, g2]);
    expect(items.map((i) => i.eventId)).toEqual(["e2", "e1"]);
    for (const i of items) expect(Number.isFinite(i.magnitude) && Number.isFinite(i.net)).toBe(true);
  });
  it("structuralFlagsByMarket", () => {
    const g = grp([px("a", "A?", 0.3), px("b", "B?", 0.3), px("c", "C?", 0.3)], { negRisk: true });
    const m = structuralFlagsByMarket(findStructural([g]));
    expect(m.get("a")).toEqual(["overround"]);
    expect(m.get("zzz")).toBeUndefined();
    expect(structuralFlagsByMarket([]).size).toBe(0);
    const dup = structuralFlagsByMarket([
      { kind: "overround", eventId: "e", eventTitle: null, conditionIds: ["a"], magnitude: 0.1, net: 0.1, description: "" },
      { kind: "overround", eventId: "e", eventTitle: null, conditionIds: ["a"], magnitude: 0.1, net: 0.1, description: "" },
      { kind: "monotonicity_violation", eventId: "e", eventTitle: null, conditionIds: ["a"], magnitude: 0.1, net: 0.1, description: "" },
    ]);
    expect(dup.get("a")).toEqual(["overround", "monotonicity_violation"]);
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
  it("keeps the (i, j) pair order across groups", () => {
    const r = mirrorPairs([
      { conditionId: "a", question: "Q1", p: 0.1 }, { conditionId: "b", question: "Q2", p: 0.1 },
      { conditionId: "c", question: "Q2", p: 0.5 }, { conditionId: "d", question: "Q1", p: 0.5 }, { conditionId: "e", question: "Q1", p: 0.9 },
    ], 0.03);
    expect(r.map((x) => x.a + x.b)).toEqual(["ad", "ae", "bc", "de"]);
  });
  it("linear in the number of markets (screen runs it over the whole universe)", () => {
    const items = Array.from({ length: 40_000 }, (_, i) => ({ conditionId: `c${i}`, question: `Will thing ${i} happen?`, p: (i % 90) / 100 }));
    const t0 = Date.now();
    expect(mirrorPairs(items, 0.03)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000); // the all-pairs scan took minutes at this size
  });
});

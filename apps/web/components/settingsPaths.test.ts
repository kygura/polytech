import { describe, expect, it } from "vitest";
import { copyPaths, getAt, issueMap, pickPaths, samePaths, setAt } from "./settingsPaths";

const s = { bankroll: 1000, limits: { perTradeUsd: 50, dailyLoss: 100, l3: { perTradeUsd: 25, categoryAllowlist: ["sports"] } }, models: {} as Record<string, string> };

describe("settings paths", () => {
  it("getAt / setAt leave the source untouched and create missing objects", () => {
    expect(getAt(s, "limits.l3.perTradeUsd")).toBe(25);
    expect(getAt(s, "limits.nope.x")).toBeUndefined();
    const n = setAt(s, "models.triage", "claude-haiku-5-5");
    expect(n.models).toEqual({ triage: "claude-haiku-5-5" });
    expect(s.models).toEqual({});
  });
  it("pickPaths builds the nested PUT body for one group", () => {
    expect(pickPaths(s, ["bankroll", "limits.perTradeUsd", "limits.l3"])).toEqual({ bankroll: 1000, limits: { perTradeUsd: 50, l3: s.limits.l3 } });
  });
  it("samePaths compares only the group's fields", () => {
    const n = setAt(s, "limits.dailyLoss", 0);
    expect(samePaths(s, n, ["limits.perTradeUsd", "limits.l3"])).toBe(true);
    expect(samePaths(s, n, ["limits.dailyLoss"])).toBe(false);
    expect(samePaths(s, setAt(s, "limits.l3.categoryAllowlist", ["sports", "crypto"]), ["limits.l3"])).toBe(false);
  });
  it("copyPaths takes saved values for the group and keeps other edits", () => {
    const edited = setAt(setAt(s, "bankroll", 2000), "limits.perTradeUsd", 70);
    const server = setAt(s, "limits.perTradeUsd", 70);
    const n = copyPaths(edited, server, ["limits.perTradeUsd"]);
    expect([n.bankroll, n.limits.perTradeUsd]).toEqual([2000, 70]);
  });
  it("issueMap", () => {
    expect(issueMap([{ path: ["limits", "l3", "perTradeUsd"], message: "too small" }])).toEqual({ "limits.l3.perTradeUsd": "too small" });
  });
});

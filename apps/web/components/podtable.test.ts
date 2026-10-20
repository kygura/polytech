import { describe, expect, it } from "vitest";
import { costLabel, podCost, podRoles, podSource, steeringLine, type Pod } from "./PodTable";

const pod = (o: Partial<Pod>) => ({ profileId: null, profileName: null, trigger: "manual", steered: false, steeringQuestion: null, steering: null, agents: [], ...o }) as Pod;

describe("podSource", () => {
  it("profile name, deleted profile, ad-hoc (steered without profile), screener", () => {
    expect(podSource(pod({ profileId: "p", profileName: "pol", trigger: "profile" }))).toEqual({ label: "pol", muted: false });
    expect(podSource(pod({ profileId: "p", trigger: "profile" }))).toEqual({ label: "deleted profile", muted: true });
    expect(podSource(pod({ steered: true }))).toEqual({ label: "ad-hoc", muted: true });
    expect(podSource(pod({}))).toEqual({ label: "screener", muted: true });
  });
});

describe("podRoles", () => {
  it("one dot per real agent: built-ins in order, custom next, judge last; default set before agents exist", () => {
    const a = (role: string) => ({ role }) as Pod["agents"][number];
    expect(podRoles(pod({ agents: [a("judge"), a("zeta"), a("news"), a("rules")] }))).toEqual(["rules", "news", "zeta", "judge"]);
    expect(podRoles(pod({}))).toContain("red_team");
  });
});

describe("steeringLine", () => {
  it("prints only deviations from the default", () => {
    expect(steeringLine(null)).toBe("");
    expect(steeringLine({ roles: ["rules", "source", "base_rate", "news", "red_team"], customRoles: [], models: {} })).toBe("");
    expect(steeringLine({ roles: ["rules"], customRoles: [{ key: "ab", prompt: "x" }], models: { judge: "claude-haiku-5-5" }, maxCostUsd: 1.5 })).toBe("roles rules · +1 custom · judge claude-haiku-5-5 · cap $1.5");
  });
});

describe("podCost", () => {
  it("sums agent usage.costUsd, ignoring non-finite", () => {
    const a = (costUsd: number) => ({ usage: { inputTokens: 0, outputTokens: 0, costUsd } }) as Pod["agents"][number];
    expect(podCost(pod({ agents: [a(0.5), a(0.92), a(NaN)] }))).toBeCloseTo(1.42);
    expect(podCost(pod({}))).toBe(0);
    expect(costLabel(1.419)).toBe("$1.42");
  });
});

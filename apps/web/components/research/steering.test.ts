import { DEFAULT_STEERING, ProfileInputSchema } from "@pm/core";
import { describe, expect, it } from "vitest";
import { blocker, buildInput, fromProfile, mapIssues, newDraft, scope, steeringDiff, toProfile } from "./steering";

describe("steeringDiff", () => {
  it("empty diff when unchanged (models of deselected roles ignored)", () => {
    expect(steeringDiff(DEFAULT_STEERING, { ...DEFAULT_STEERING, models: {} })).toEqual({});
    expect(steeringDiff({ ...DEFAULT_STEERING, roles: ["rules"] }, { ...DEFAULT_STEERING, roles: ["rules"], models: { news: "claude-haiku-5-5" } })).toEqual({});
  });
  it("sends only changed fields; cleared question becomes empty string", () => {
    const base = { ...DEFAULT_STEERING, question: "why?" };
    expect(steeringDiff(base, { ...base, roles: ["rules", "news"], maxCostUsd: 2 })).toEqual({ roles: ["rules", "news"], maxCostUsd: 2 });
    expect(steeringDiff(base, { ...base, question: "  " })).toEqual({ question: "" });
  });
});

describe("mapIssues / scope", () => {
  it("keys by dotted path, first issue wins, scope strips the prefix", () => {
    const e = mapIssues([{ path: ["steering", "customRoles", 0, "key"], message: "bad" }, { path: ["steering", "customRoles", 0, "key"], message: "later" }, { path: [], message: "top" }]);
    expect(e).toEqual({ "steering.customRoles.0.key": "bad", "": "top" });
    expect(scope(e, "steering.")).toEqual({ "customRoles.0.key": "bad" });
  });
});

describe("draft <-> body", () => {
  it("blank numbers are omitted, the body passes the API schema, and it round-trips", () => {
    const d = newDraft();
    d.name = " p1 "; d.every = 6; d.unit = "h"; d.filter.tags = "a, b,"; d.filter.endsMax = 30; d.filter.limit = 5;
    const body = buildInput(d);
    expect(body).toMatchObject({ name: "p1", everyMin: 360, filter: { tagsAny: ["a", "b"], endsWithinDays: { max: 30 }, limit: 5 } });
    expect(body.filter).not.toHaveProperty("minVol24h");
    const parsed = ProfileInputSchema.parse(body);
    const back = fromProfile(toProfile({ ...parsed, id: "x", lastRunAt: null, updatedAt: new Date(0) }));
    expect(back.every).toBe(6);
    expect(back.unit).toBe("h");
    expect(buildInput(back)).toEqual({ ...body, filter: { ...body.filter, skipIfResearchedWithinHours: 24 } }); // server default round-trips
  });
  it("blocker pre-checks", () => {
    const d = newDraft();
    expect(blocker(d)).toBe("name required");
    d.name = "x";
    expect(blocker(d)).toBeNull();
    d.steering.roles = [];
    expect(blocker(d)).toMatch(/built-in/);
  });
});

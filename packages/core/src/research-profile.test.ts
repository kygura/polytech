import { DEFAULT_MODELS } from "../../agents/src/router";
import { describe, expect, it } from "vitest";
import { ALLOWED_MODELS, DEFAULT_STEERING, ProfileFilterSchema, SteeringSchema } from "./research-profile";

const ok = (o: object) => SteeringSchema.safeParse({ ...DEFAULT_STEERING, ...o }).success;

describe("SteeringSchema", () => {
  it("accepts the default and a role subset", () => {
    expect(SteeringSchema.parse(DEFAULT_STEERING)).toEqual(DEFAULT_STEERING);
    expect(ok({ roles: ["rules"], question: "x" })).toBe(true);
  });
  it("rejects unknown role, empty roles, extra keys", () => {
    expect(ok({ roles: ["rules", "nope"] })).toBe(false);
    expect(ok({ roles: [] })).toBe(false);
    expect(ok({ bogus: 1 })).toBe(false);
  });
  it("rejects more than 10 roles / more than 5 custom", () => {
    const c = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `role_${i}`, prompt: "p" }));
    expect(ok({ customRoles: c(5) })).toBe(true); // 5 + 5 = 10
    expect(ok({ customRoles: c(6) })).toBe(false);
  });
  it("rejects bad custom keys, collisions and duplicates", () => {
    for (const key of ["Bad", "a", "1abc", "has-dash", "x".repeat(25), "rules"])
      expect(ok({ customRoles: [{ key, prompt: "p" }] })).toBe(false);
    expect(ok({ customRoles: [{ key: "dup_a", prompt: "p" }, { key: "dup_a", prompt: "p" }] })).toBe(false);
    expect(ok({ customRoles: [{ key: "macro", prompt: "" }] })).toBe(false);
    expect(ok({ customRoles: [{ key: "judge", prompt: "p" }] })).toBe(false); // judge is reserved
  });
  it("models: allowlist, known role keys only", () => {
    expect(ok({ models: { judge: "claude-opus-5-5", rules: "claude-haiku-5-5" } })).toBe(true);
    expect(ok({ models: { rules: "gpt-5" } })).toBe(false);
    expect(ok({ models: { macro: "claude-opus-5-5" } })).toBe(false); // not a selected role
    expect(ok({ roles: ["rules"], models: { news: "claude-opus-5-5" } })).toBe(false); // role not selected
    expect(ok({ customRoles: [{ key: "macro", prompt: "p" }], models: { macro: "claude-opus-5-5" } })).toBe(true);
  });
  it("bounds question length and cost cap", () => {
    expect(ok({ question: "x".repeat(2001) })).toBe(false);
    expect(ok({ maxCostUsd: -1 })).toBe(false);
  });
  it("allowlist covers every default model", () => {
    for (const m of Object.values(DEFAULT_MODELS)) expect(ALLOWED_MODELS).toContain(m);
  });
});

describe("ProfileFilterSchema", () => {
  it("defaults and bounds", () => {
    expect(ProfileFilterSchema.parse({})).toMatchObject({ skipIfResearchedWithinHours: 24, sort: "priority", limit: 10 });
    for (const bad of [{ limit: 0 }, { limit: 51 }, { sort: "x" }, { extra: 1 }]) expect(ProfileFilterSchema.safeParse(bad).success).toBe(false);
  });
});

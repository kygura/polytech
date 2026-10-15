import { describe, expect, it } from "vitest";
import { AgentOutput, capConfidence } from "./agent-output";

const fact = { claim: "c", url: "https://example.com/x", quote: "q", date: "2026-10-01" };
const ok = { role: "news", probability: 0.4, confidence: 0.7, key_facts: [fact], risks: ["r"], notes: "short" };

describe("AgentOutput", () => {
  it("accepts a valid result and a rules-reader null probability", () => {
    expect(AgentOutput.safeParse(ok).success).toBe(true);
    expect(AgentOutput.safeParse({ ...ok, role: "rules", probability: null }).success).toBe(true);
  });
  it.each([
    ["bad role", { role: "judge" }],
    ["probability > 1", { probability: 1.1 }],
    ["confidence < 0", { confidence: -0.1 }],
    ["rules with a probability", { role: "rules", probability: 0.5 }],
    ["fact without url", { key_facts: [{ ...fact, url: "not a url" }] }],
    ["missing risks", { risks: undefined }],
    ["notes over 150 words", { notes: Array(151).fill("w").join(" ") }],
  ])("rejects %s", (_n, patch) => {
    expect(AgentOutput.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
  it("notes of exactly 150 words pass", () => {
    expect(AgentOutput.safeParse({ ...ok, notes: Array(150).fill("w").join(" ") }).success).toBe(true);
  });
});

describe("capConfidence", () => {
  it("caps to 0.5 when estimates straddle p_mid", () => {
    expect(capConfidence(0.9, [0.3, 0.6], 0.5)).toBe(0.5);
  });
  it("leaves confidence when all on one side, equal to mid, or fewer than two", () => {
    expect(capConfidence(0.9, [0.6, 0.7], 0.5)).toBe(0.9);
    expect(capConfidence(0.9, [0.5, 0.7], 0.5)).toBe(0.9);
    expect(capConfidence(0.9, [0.3], 0.5)).toBe(0.9);
  });
  it("ignores null probabilities and never raises low confidence", () => {
    expect(capConfidence(0.9, [null, 0.3, 0.6], 0.5)).toBe(0.5);
    expect(capConfidence(0.3, [0.3, 0.6], 0.5)).toBe(0.3);
    expect(capConfidence(0.9, [null, 0.3], 0.5)).toBe(0.9);
  });
});

import { describe, expect, it } from "vitest";
import { evidenceConfidence, isStrong, UNVERIFIED_C, type GradedFact } from "./evidence";

const FED = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm";
const cited = [{ url: FED, quoteCheck: "found" as const }, { url: "https://substack.example/fed-take", quoteCheck: "found" as const }];
const g = (url: string, reputation: GradedFact["reputation"], claim_strength: GradedFact["claim_strength"]): GradedFact => ({ url, reputation, claim_strength });

describe("evidence gate", () => {
  it("strong = high reputation and a verified claim, nothing less", () => {
    expect(isStrong({ reputation: "high", claim_strength: "verified" })).toBe(true);
    expect(isStrong({ reputation: "high", claim_strength: "partial" })).toBe(false);
    expect(isStrong({ reputation: "medium", claim_strength: "verified" })).toBe(false);
  });
  it("a strong fact on a cited url keeps the judge's confidence (www, case, trailing slash and fragment ignored)", () => {
    const f = g("https://FederalReserve.gov/newsevents/pressreleases/monetary20260916a.htm/#x", "high", "verified");
    expect(evidenceConfidence(0.8, [f], cited)).toEqual({ c: 0.8, strong: 1 });
  });
  it("any domain can be strong; the grade decides, not the address", () => {
    expect(evidenceConfidence(0.7, [g("https://substack.example/fed-take", "high", "verified")], cited).c).toBe(0.7);
  });
  it("weak grades, or a strong grade on a url no analyst cited: capped", () => {
    expect(evidenceConfidence(0.8, [g(FED, "high", "partial"), g("https://substack.example/fed-take", "low", "verified")], cited)).toEqual({ c: UNVERIFIED_C, strong: 0 });
    expect(evidenceConfidence(0.8, [g("https://made-up.example/x", "high", "verified")], cited)).toEqual({ c: UNVERIFIED_C, strong: 0 });
  });
  it("a strong grade on a misquoted or unfetched fact does not count", () => {
    for (const quoteCheck of ["not_found", "unfetched"] as const)
      expect(evidenceConfidence(0.8, [g(FED, "high", "verified")], [{ url: FED, quoteCheck }])).toEqual({ c: UNVERIFIED_C, strong: 0 });
    // another fact on the same url with its quote found does
    expect(evidenceConfidence(0.8, [g(FED, "high", "verified")], [{ url: FED, quoteCheck: "not_found" }, { url: FED, quoteCheck: "found" }]).strong).toBe(1);
  });
  it("never raises a low judge confidence", () => {
    expect(evidenceConfidence(0.15, [], cited).c).toBe(0.15);
  });
});

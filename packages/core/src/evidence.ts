// Evidence gate on confidence: a thesis keeps the judge's confidence only when it rests on a strong fact, graded by the judge
// on the source's reputation for that kind of claim and on what the quote itself establishes (agents/judge.ts key_evidence).

/** Confidence for a thesis without a strong fact: the market keeps most of the weight. */
export const UNVERIFIED_C = 0.4;

export type Reputation = "high" | "medium" | "low";
export type ClaimStrength = "verified" | "partial" | "weak";
export type GradedFact = { url: string; reputation: Reputation; claim_strength: ClaimStrength };

/** A reputable source stating a specific, dated, checkable fact that bears on resolution. */
export const isStrong = (f: Pick<GradedFact, "reputation" | "claim_strength">) => f.reputation === "high" && f.claim_strength === "verified";

const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1").toLowerCase();

/**
 * The judge's confidence stands when at least one strong fact is among the urls the analysts actually cited (a grade on a url
 * nobody retrieved counts for nothing); otherwise it is capped at UNVERIFIED_C. Never raises a confidence.
 */
export function evidenceConfidence(c: number, graded: readonly GradedFact[], cited: readonly string[]): { c: number; strong: number } {
  const have = new Set(cited.map(norm));
  const strong = graded.filter((f) => isStrong(f) && have.has(norm(f.url))).length;
  return { c: strong > 0 ? c : Math.min(c, UNVERIFIED_C), strong };
}

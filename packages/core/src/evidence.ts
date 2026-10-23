// Evidence gate on confidence: a thesis keeps the judge's confidence only when it rests on a strong fact, graded by the judge
// on the source's reputation for that kind of claim and on what the quote itself establishes (agents/judge.ts key_evidence),
// whose quote was found in the text the analyst's runner actually fetched (quote.ts).
import { urlKey, type QuoteCheck } from "./quote";

/** Confidence for a thesis without a strong fact: the market keeps most of the weight. */
export const UNVERIFIED_C = 0.4;

export type Reputation = "high" | "medium" | "low";
export type ClaimStrength = "verified" | "partial" | "weak";
export type GradedFact = { url: string; reputation: Reputation; claim_strength: ClaimStrength };

/** A reputable source stating a specific, dated, checkable fact that bears on resolution. */
export const isStrong = (f: Pick<GradedFact, "reputation" | "claim_strength">) => f.reputation === "high" && f.claim_strength === "verified";

/** An analyst's fact: its url and whether its quote was found in the fetched text. */
export type CitedFact = { url: string; quoteCheck: QuoteCheck };

/**
 * The judge's confidence stands when at least one strong fact sits on a url an analyst cited with a quote found in the fetched
 * text (a grade on a url nobody retrieved, or on a misquote, counts for nothing); otherwise it is capped at UNVERIFIED_C.
 * Never raises a confidence.
 */
export function evidenceConfidence(c: number, graded: readonly GradedFact[], cited: readonly CitedFact[]): { c: number; strong: number } {
  const ok = new Set(cited.filter((f) => f.quoteCheck === "found").map((f) => urlKey(f.url)));
  const strong = graded.filter((f) => isStrong(f) && ok.has(urlKey(f.url))).length;
  return { c: strong > 0 ? c : Math.min(c, UNVERIFIED_C), strong };
}

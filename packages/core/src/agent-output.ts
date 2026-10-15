import { z } from "zod";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const AgentOutput = z
  .object({
    role: z.enum(["rules", "source", "base_rate", "news", "red_team"]),
    probability: z.number().min(0).max(1).nullable(), // null for rules reader
    confidence: z.number().min(0).max(1),
    key_facts: z.array(z.object({ claim: z.string(), url: z.url(), quote: z.string(), date: z.string() })),
    risks: z.array(z.string()),
    notes: z.string().refine((n) => words(n) <= 150, "notes must be <= 150 words"),
  })
  .refine((o) => o.role !== "rules" || o.probability === null, {
    message: "rules reader must have probability null",
    path: ["probability"],
  });
export type AgentOutput = z.infer<typeof AgentOutput>;

/** Probability-bearing estimates straddling p_mid (one above, one below) cap confidence at 0.5. */
export function capConfidence(confidence: number, probs: (number | null)[], pMid: number): number {
  const ps = probs.filter((p): p is number => p != null);
  const straddle = ps.some((p) => p > pMid) && ps.some((p) => p < pMid);
  return straddle ? Math.min(confidence, 0.5) : confidence;
}

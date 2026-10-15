export interface ThesisAge {
  mid: number; // p_mid at thesis time
  createdAt: number; // epoch ms
  resolvesAt: number; // epoch ms
}
export type ReResearchReason = "PRICE_MOVE" | "CATALYST_PASSED" | "NEW_HIT" | "STALE";

const DAY = 86_400_000;

/** SPEC re-research triggers. Catalysts are epoch ms; only ones that passed since the thesis count. */
export function shouldReResearch(t: ThesisAge, now: number, mid: number, catalysts: number[], hasNewHit: boolean): ReResearchReason[] {
  const r: ReResearchReason[] = [];
  if (Math.round(Math.abs(mid - t.mid) * 1e4) > 800) r.push("PRICE_MOVE"); // > 8c, rounded to dodge float noise
  if (catalysts.some((c) => c > t.createdAt && c <= now)) r.push("CATALYST_PASSED");
  if (hasNewHit) r.push("NEW_HIT");
  if (now - t.createdAt > 72 * 3_600_000 && t.resolvesAt - now < 14 * DAY) r.push("STALE");
  return r;
}

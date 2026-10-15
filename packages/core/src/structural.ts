import { takerFeePerShare } from "./fees";
import { sortAsc } from "./screen/book";
import type { Level } from "./types";

export type Leg = { conditionId: string; bids: Level[]; asks: Level[] };

/** Mutually exclusive group: fee-adjusted sum of best asks < 1 (buy all) or best bids > 1 (sell all). */
export function negRiskArb(
  legs: Leg[], feeRate: number,
): { kind: "buy-all" | "sell-all"; edge: number; legs: string[] } | null {
  if (legs.length < 2) return null;
  const ids = legs.map((l) => l.conditionId);
  const asks = legs.map((l) => sortAsc(l.asks)[0]?.price);
  if (asks.every((p) => p != null)) {
    const cost = (asks as number[]).reduce((t, p) => t + p + takerFeePerShare(feeRate, p), 0);
    if (cost < 1) return { kind: "buy-all", edge: 1 - cost, legs: ids };
  }
  const bids = legs.map((l) => sortAsc(l.bids).at(-1)?.price);
  if (bids.every((p) => p != null)) {
    const proceeds = (bids as number[]).reduce((t, p) => t + p - takerFeePerShare(feeRate, p), 0);
    if (proceeds > 1) return { kind: "sell-all", edge: proceeds - 1, legs: ids };
  }
  return null;
}

export type LadderRung = { conditionId: string; date: number; p: number };

/** "X by earlier date" must not be priced above "X by later date". */
export function ladderViolations(rungs: LadderRung[], tol = 0) {
  const out: { earlier: string; later: string; gap: number }[] = [];
  for (const a of rungs)
    for (const b of rungs)
      if (a.date < b.date && a.p - b.p > tol)
        out.push({ earlier: a.conditionId, later: b.conditionId, gap: a.p - b.p });
  return out;
}

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type MirrorItem = { conditionId: string; question: string; p: number };

/** Same normalized question listed twice with prices further apart than `threshold`. */
export function mirrorPairs(items: MirrorItem[], threshold = 0.03) {
  const out: { a: string; b: string; diff: number }[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const x = items[i]!, y = items[j]!;
      const diff = Math.abs(x.p - y.p);
      if (norm(x.question) === norm(y.question) && diff > threshold)
        out.push({ a: x.conditionId, b: y.conditionId, diff });
    }
  return out;
}

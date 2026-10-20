// DESIGN 12.4: pure helpers behind the Journal charts and breakdown. Rows are the JSON of `JournalRow` (@pm/core).
import type { JournalRow } from "@pm/core";

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const mean = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter(fin);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const time = (r: Pick<JournalRow, "resolvedAt">) => (r.resolvedAt ? new Date(r.resolvedAt).getTime() : 0);

export const ROLLING = 20;
export const GATE_N = 30;

export type RollingPoint = { i: number; t: number; model: number; market: number; pre: number | null };

/** Rolling mean Brier over resolution order (oldest first). One point per row from the `window`-th on; needs >= window rows with model and market Brier. */
export function rollingBrier(rows: JournalRow[], window = ROLLING): RollingPoint[] {
  const rs = rows.filter((r) => r.result && fin(r.brierModel) && fin(r.brierMarket)).sort((a, b) => time(a) - time(b));
  const out: RollingPoint[] = [];
  for (let i = window - 1; i < rs.length; i++) {
    const w = rs.slice(i - window + 1, i + 1);
    out.push({ i, t: time(rs[i]!), model: mean(w.map((r) => r.brierModel))!, market: mean(w.map((r) => r.brierMarket))!, pre: mean(w.map((r) => r.brierPre)) });
  }
  return out;
}

export type DriftBin = { lo: number; hi: number; n24: number; n7: number };
export type DriftHist = { bins: DriftBin[]; mean24: number | null; mean7: number | null; n24: number; n7: number };

/** 1-cent bins from -10 to +10 (clamped: <= -10 and >= +10 land in the end bins). Drift is stored in probability units; bins and means are in cents. */
export function driftHistogram(rows: Pick<JournalRow, "drift24h" | "drift7d">[], lo = -10, hi = 10): DriftHist {
  const bins: DriftBin[] = Array.from({ length: hi - lo }, (_, i) => ({ lo: lo + i, hi: lo + i + 1, n24: 0, n7: 0 }));
  const bin = (c: number) => Math.min(hi - lo - 1, Math.max(0, Math.floor(c) - lo));
  const a = rows.map((r) => r.drift24h).filter(fin).map((d) => d * 100);
  const b = rows.map((r) => r.drift7d).filter(fin).map((d) => d * 100);
  for (const c of a) bins[bin(c)]!.n24++;
  for (const c of b) bins[bin(c)]!.n7++;
  return { bins, mean24: mean(a), mean7: mean(b), n24: a.length, n7: b.length };
}

export type GroupBy = "category" | "model" | "liquidity" | "r";
export const GROUPS: [GroupBy, string][] = [["category", "category"], ["model", "model"], ["liquidity", "liquidity band"], ["r", "R bucket"]];
export const isGroupBy = (v: unknown): v is GroupBy => GROUPS.some(([g]) => g === v);

const BAND_ORDER = ["<$5k", "$5–25k", "$25–100k", ">$100k", "unknown"];
const R_ORDER = ["<0.3", "0.3–0.6", ">0.6", "unknown"];
export const liquidityBand = (l: number | null): string => (!fin(l) ? "unknown" : l < 5_000 ? "<$5k" : l < 25_000 ? "$5–25k" : l < 100_000 ? "$25–100k" : ">$100k");
export const rBucket = (r: number | null): string => (!fin(r) ? "unknown" : r < 0.3 ? "<0.3" : r <= 0.6 ? "0.3–0.6" : ">0.6");

const KEY: Record<GroupBy, (r: JournalRow) => string> = {
  category: (r) => r.category ?? "unknown", model: (r) => r.model, liquidity: (r) => liquidityBand(r.liquidityAt), r: (r) => rBucket(r.r),
};

export type BreakdownRow = {
  key: string; n: number; brier: number | null; market: number | null; pre: number | null; logLoss: number | null;
  drift7: number | null; // cents
  pnl: number | null; hit: number | null; gate: string;
  /** n < min n: rendered muted, sorted last. */
  low: boolean;
};

/** Group resolved rows (n, score means, P&L, hit rate over staked rows). Groups under `minN` stay in the list but `low` and last. */
export function breakdownRows(rows: JournalRow[], by: GroupBy, minN: number): BreakdownRow[] {
  const groups = new Map<string, JournalRow[]>();
  for (const r of rows) if (r.result) { const k = KEY[by](r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const order = by === "liquidity" ? BAND_ORDER : by === "r" ? R_ORDER : [];
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const out = [...groups].map(([key, rs]): BreakdownRow => {
    const pnl = rs.map((r) => r.paperPnl).filter(fin);
    const staked = rs.filter((r) => fin(r.stake) && r.stake > 0 && fin(r.paperPnl));
    const d = mean(rs.map((r) => r.drift7d));
    return {
      key, n: rs.length, brier: mean(rs.map((r) => r.brierModel)), market: mean(rs.map((r) => r.brierMarket)), pre: mean(rs.map((r) => r.brierPre)), logLoss: mean(rs.map((r) => r.logLoss)),
      drift7: d == null ? null : d * 100, pnl: pnl.length ? pnl.reduce((a, b) => a + b, 0) : null,
      hit: staked.length ? staked.filter((r) => r.paperPnl! > 0).length / staked.length : null, gate: `${rs.length}/${GATE_N}`, low: rs.length < minN,
    };
  });
  return out.sort((a, b) => Number(a.low) - Number(b.low) || (order.length ? rank(a.key) - rank(b.key) : 0) || b.n - a.n || a.key.localeCompare(b.key));
}

/** Parse the `min n` URL param: non-negative integer, default 5. */
export const parseMinN = (v: string | undefined): number => (v && /^\d+$/.test(v) ? Math.min(999, Number(v)) : 5);

/** The sparse x labels for the drift histogram: every 5 cents, signed. */
export const signed5 = (c: number) => (c === 0 ? "0" : `${c > 0 ? "+" : "−"}${Math.abs(c)}`);

/** Index of the entry of `xs` (ascending) closest to `x`; -1 when empty. For chart hover. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1, d = Infinity;
  xs.forEach((v, i) => { const e = Math.abs(v - x); if (e < d) (d = e), (best = i); });
  return best;
}

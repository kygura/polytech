// Journal maths (SPEC Rev 7 item 4). Pure; rows mirror the `journal` table, filled by the calibrate job.
import { logLoss } from "./calibration";

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const mean = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter(fin);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const sum = (xs: (number | null | undefined)[]): number => xs.filter(fin).reduce((a, b) => a + b, 0);
const EPS = 1e-6;

export interface JournalRow {
  thesisId: string;
  conditionId: string;
  category: string | null;
  model: string;
  pHat: number;
  pPre: number | null; // mean of blind agent estimates
  midAt: number | null;
  liquidityAt: number | null;
  r: number | null;
  side: "YES" | "NO";
  stake: number | null;
  result: "YES" | "NO" | null; // null until resolved
  resolvedAt: Date | string | null;
  brierModel: number | null;
  brierMarket: number | null;
  brierPre: number | null;
  logLoss: number | null;
  drift24h: number | null;
  drift7d: number | null;
  paperPnl: number | null;
}

/** Signed move of the mid toward our estimate p (prob units): positive = market moved our way. */
export function drift(midAtResult: number, midLater: number, p: number): number {
  const dir = Math.sign(p - midAtResult);
  return dir === 0 ? 0 : (midLater - midAtResult) * dir;
}

/** P&L of buying `stake` of `side` at all-in price aEff (fees/slippage inside). outcome 1 = YES won, 0 = NO won. */
export function paperPnl(a: { side: "YES" | "NO"; stake: number; aEff: number; outcome: 0 | 1 }): number {
  if (!(a.stake > 0) || !(a.aEff > 0)) return 0;
  const win = a.side === "YES" ? a.outcome : 1 - a.outcome;
  return (a.stake / a.aEff) * win - a.stake;
}

/** Scale p's log-odds by k, clamped to [1e-6, 1-1e-6] so it stays finite. */
export function extremize(p: number, k: number): number {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return 1 / (1 + Math.exp(-k * Math.log(q / (1 - q))));
}

const BANDS: [string, number][] = [["<2k", 2000], ["2k–10k", 10_000], ["10k–50k", 50_000]];
export const liquidityBand = (l: number | null): string => (fin(l) ? (BANDS.find(([, hi]) => l < hi)?.[0] ?? "50k+") : "unknown");

export const rBucket = (r: number | null): string =>
  !fin(r) ? "unknown" : ["0–.25", ".25–.5", ".5–.75", ".75–1"][Math.min(3, Math.max(0, Math.floor(r * 4)))]!;

export interface BreakdownRow {
  key: string;
  n: number; // resolved rows
  brierModel: number | null;
  brierMarket: number | null;
  paperPnl: number | null;
}

export interface JournalSummary {
  n: number;
  resolved: number;
  brierModel: number | null;
  brierMarket: number | null;
  brierPre: number | null;
  logLoss: number | null;
  skillVsMarket: number | null; // brierMarket - brierModel; positive = beats the crowd
  paperPnl: number;
  hitRate: number | null; // staked resolved rows with paperPnl > 0
  byCategory: BreakdownRow[];
  byLiquidity: BreakdownRow[];
  byModel: BreakdownRow[];
  byR: BreakdownRow[];
  pnlSeries: { t: string; pnl: number; cum: number }[];
}

function breakdown(rows: JournalRow[], key: (r: JournalRow) => string): BreakdownRow[] {
  const groups = new Map<string, JournalRow[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups]
    .map(([k, rs]) => {
      const res = rs.filter((r) => r.result);
      const pnl = rs.map((r) => r.paperPnl).filter(fin);
      return { key: k, n: res.length, brierModel: mean(res.map((r) => r.brierModel)), brierMarket: mean(res.map((r) => r.brierMarket)), paperPnl: pnl.length ? sum(pnl) : null };
    })
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Journal KPIs. Score means are over resolved rows; skill compares model vs market on rows that have both. */
export function summarize(rows: JournalRow[]): JournalSummary {
  const res = rows.filter((r) => r.result);
  const both = res.filter((r) => fin(r.brierModel) && fin(r.brierMarket));
  const bm = mean(both.map((r) => r.brierModel));
  const bk = mean(both.map((r) => r.brierMarket));
  const staked = res.filter((r) => fin(r.stake) && r.stake > 0 && fin(r.paperPnl));
  let cum = 0;
  const pnlSeries = res
    .filter((r) => r.resolvedAt && fin(r.paperPnl))
    .sort((a, b) => new Date(a.resolvedAt!).getTime() - new Date(b.resolvedAt!).getTime())
    .map((r) => ({ t: new Date(r.resolvedAt!).toISOString(), pnl: r.paperPnl!, cum: (cum += r.paperPnl!) }));
  return {
    n: rows.length,
    resolved: res.length,
    brierModel: mean(res.map((r) => r.brierModel)),
    brierMarket: mean(res.map((r) => r.brierMarket)),
    brierPre: mean(res.map((r) => r.brierPre)),
    logLoss: mean(res.map((r) => r.logLoss)),
    skillVsMarket: bm !== null && bk !== null ? bk - bm : null,
    paperPnl: sum(rows.map((r) => r.paperPnl)),
    hitRate: staked.length ? staked.filter((r) => r.paperPnl! > 0).length / staked.length : null,
    byCategory: breakdown(rows, (r) => r.category ?? "unknown"),
    byLiquidity: breakdown(rows, (r) => liquidityBand(r.liquidityAt)),
    byModel: breakdown(rows, (r) => r.model),
    byR: breakdown(rows, (r) => rBucket(r.r)),
    pnlSeries,
  };
}

/** Grid search (0.5…3.0, step 0.05) for the log-odds multiplier minimising mean log loss on resolved rows. null if < 30 resolved. */
export function fitExtremize(rows: Pick<JournalRow, "pHat" | "result">[]): number | null {
  const rs = rows.filter((r) => r.result && fin(r.pHat));
  if (rs.length < 30) return null;
  let best = 1, bestLoss = Infinity;
  for (let i = 0; i <= 50; i++) {
    const k = Math.round((0.5 + i * 0.05) * 100) / 100;
    const loss = mean(rs.map((r) => logLoss(extremize(r.pHat, k), r.result === "YES" ? 1 : 0)))!;
    if (loss < bestLoss - 1e-12) (bestLoss = loss), (best = k);
  }
  return best;
}

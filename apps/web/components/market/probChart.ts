// Pure helpers for the market YES/NO probability chart (DESIGN 13.4). No React, no DOM. Probabilities are 0..1, axis values are percents.
import { RANGES, type HistPt, type Range } from "../../lib/history";

export type { HistPt, Range };
export type Outcome = "YES" | "NO";
export type AxisMode = "full" | "fit";
export type Axis = { lo: number; hi: number; ticks: number[] };
export type XTick = { ts: number; x: number; label: string };

/** `[` / `]` step the range, clamped at both ends. */
export const stepRange = (r: Range, d: 1 | -1): Range => RANGES[Math.min(RANGES.length - 1, Math.max(0, RANGES.indexOf(r) + d))]!;

// ---- data ----------------------------------------------------------------------------------------------------------

/** Finite ts and mid in [0,1], ascending, one point per ts (the later one wins). */
export function cleanPoints(raw: readonly { ts: unknown; mid: unknown }[] | null | undefined): HistPt[] {
  const out: HistPt[] = [];
  for (const p of (raw ?? []).slice().sort((a, b) => Number(a.ts) - Number(b.ts))) {
    const ts = Number(p.ts), mid = Number(p.mid);
    if (!Number.isFinite(ts) || !Number.isFinite(mid) || mid < 0 || mid > 1 || p.mid == null) continue;
    if (out.length && out.at(-1)!.ts === ts) out.pop();
    out.push({ ts, mid });
  }
  return out;
}

/** The live mid as the last point at `now` (never before the last point). No usable live mid = the points unchanged. */
export function mergeLive(points: readonly HistPt[], liveMid: number | null | undefined, now: number): HistPt[] {
  if (liveMid == null || !Number.isFinite(liveMid) || liveMid < 0 || liveMid > 1) return points as HistPt[];
  return [...points, { ts: Math.max(now, (points.at(-1)?.ts ?? 0) + 1), mid: liveMid }];
}

const H = 3_600_000, D = 24 * H;
export const WINDOW_MS: Record<Range, number | null> = { "1d": D, "1w": 7 * D, "1m": 30 * D, all: null };

/** X domain: the range window ending at the last point, but never starting before the first point (a short snapshot history is not stretched over a month). */
export function xDomain(points: readonly HistPt[], range: Range): [number, number] {
  if (!points.length) return [0, 1];
  const t1 = points.at(-1)!.ts, w = WINDOW_MS[range];
  return [w == null ? points[0]!.ts : Math.max(points[0]!.ts, t1 - w), t1];
}

/** Index of the point closest in time to `ts` (ascending points); -1 when empty. */
export function nearestIndex(points: readonly { ts: number }[], ts: number): number {
  if (!points.length) return -1;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (points[m]!.ts <= ts) lo = m; else hi = m;
  }
  return Math.abs(points[lo]!.ts - ts) <= Math.abs(points[hi]!.ts - ts) ? lo : hi;
}

/** Linearly interpolated mid at `ts` (clamped to the ends); null when empty. */
export function valueAt(points: readonly HistPt[], ts: number): number | null {
  if (!points.length) return null;
  if (ts <= points[0]!.ts) return points[0]!.mid;
  if (ts >= points.at(-1)!.ts) return points.at(-1)!.mid;
  let lo = 0, hi = points.length - 1; // points[lo].ts <= ts < points[hi].ts
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (points[m]!.ts <= ts) lo = m; else hi = m;
  }
  const a = points[lo]!, b = points[hi]!;
  return a.mid + ((b.mid - a.mid) * (ts - a.ts)) / (b.ts - a.ts);
}

// ---- scales & price formatting ---------------------------------------------------------------------------------------

/** Linear map [d0,d1] -> [r0,r1]; a zero-width domain maps to r0. */
export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** `41¢` (tick 0.01) or `41.2¢` (tick 0.001). */
export function cents(p: number, tick = 0.01): string {
  const dec = Math.max(0, Math.round(-Math.log10(tick)) - 2);
  return `${(p * 100).toFixed(dec)}¢`;
}

// ---- y axis ----------------------------------------------------------------------------------------------------------

export const FULL_AXIS: Axis = { lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] };
const STEPS = [1, 2, 5, 10, 25] as const;
const MAX_TICKS = 6;

/** Min/max percent over the visible lines (YES, NO = 100 − YES) plus any extra percent values (p̂, own orders); null with no data. */
export function extent(points: readonly HistPt[], showYes: boolean, showNo: boolean, extra: readonly number[] = []): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  const see = (v: number) => { if (v < min) min = v; if (v > max) max = v; };
  for (const p of points) {
    if (showYes) see(p.mid * 100);
    if (showNo) see(100 - p.mid * 100);
  }
  if (min === Infinity) return null;
  for (const v of extra) if (Number.isFinite(v)) see(v);
  return { min, max };
}

/** Fit axis: lo/hi snapped to the smallest of 1/2/5/10/25 that gives <= 6 ticks; ticks are distinct whole percents. */
export function fitAxis(min: number, max: number): Axis {
  for (const step of STEPS) {
    const lo = Math.max(0, Math.floor((min - 2) / step) * step), hi = Math.min(100, Math.ceil((max + 2) / step) * step);
    if ((hi - lo) / step + 1 <= MAX_TICKS || step === 25) {
      const ticks: number[] = [];
      for (let v = lo; v <= hi; v += step) ticks.push(v);
      return { lo, hi, ticks };
    }
  }
  return FULL_AXIS;
}

/** 0–100 mode, or Fit. Fit falls back to 0–100 when both lines are shown and together span more than 60 points. */
export function axisFor(mode: AxisMode, ext: { min: number; max: number } | null, bothLines: boolean): Axis {
  if (mode === "full" || !ext || !Number.isFinite(ext.min) || !Number.isFinite(ext.max)) return FULL_AXIS;
  if (bothLines && ext.max - ext.min > 60) return FULL_AXIS;
  return fitAxis(ext.min, ext.max);
}

// ---- x axis & time labels --------------------------------------------------------------------------------------------

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const p2 = (n: number) => String(n).padStart(2, "0");
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

type Unit = "m" | "h" | "d" | "wk" | "mo";
type Step = { unit: Unit; n: number };
// Finest to coarsest. Base step per range: 1D every 4h, 1W daily, 1M every 5th day of the month, ALL monthly (weekly under 90 days).
const LADDER: readonly Step[] = [
  { unit: "m", n: 10 }, { unit: "m", n: 30 }, { unit: "h", n: 1 }, { unit: "h", n: 2 }, { unit: "h", n: 4 }, { unit: "h", n: 12 },
  { unit: "d", n: 1 }, { unit: "d", n: 5 }, { unit: "wk", n: 1 }, { unit: "mo", n: 1 },
];
const BASE: Record<Range, number> = { "1d": 4, "1w": 6, "1m": 7, all: 9 };

/** Local-time ticks of one ladder step inside [t0,t1]. */
function ticksOf(s: Step, t0: number, t1: number): number[] {
  const out: number[] = [];
  if (s.unit === "m" || s.unit === "h") {
    const ms = s.unit === "m" ? s.n * 60_000 : s.n * H, d = new Date(t0);
    if (s.unit === "m") d.setMinutes(Math.floor(d.getMinutes() / s.n) * s.n, 0, 0); else d.setHours(Math.floor(d.getHours() / s.n) * s.n, 0, 0, 0);
    for (let t = d.getTime(), i = 0; t <= t1 && i < 400; t += ms, i++) if (t >= t0) out.push(t);
    return out;
  }
  if (s.unit === "mo") {
    for (let d = new Date(new Date(t0).getFullYear(), new Date(t0).getMonth(), 1), i = 0; d.getTime() <= t1 && i < 400; d.setMonth(d.getMonth() + 1), i++) if (d.getTime() >= t0) out.push(d.getTime());
    return out;
  }
  const d = new Date(t0);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; d.getTime() <= t1 && i < 400; d.setDate(d.getDate() + 1), i++) {
    const ok = s.unit === "wk" ? d.getDay() === 1 : s.n === 1 || d.getDate() % s.n === 0;
    if (d.getTime() >= t0 && ok) out.push(d.getTime());
  }
  return out;
}

function stepLabel(s: Step, range: Range, ts: number): string {
  const d = new Date(ts);
  if (s.unit === "m" || s.unit === "h") return hm(d);
  if (s.unit === "d" && range === "1w") return `${DOW[d.getDay()]} ${d.getDate()}`;
  if (s.unit === "mo") return `${MON[d.getMonth()]} ’${p2(d.getFullYear() % 100)}`;
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

/** Axis labels for [t0,t1] drawn over `width` px: first and last always, aligned ticks between them, dropped when closer than `minGap` px.
 * A step finer than the range's own is used when the span is too short to hold two ticks (a few hours of snapshots on 1D, say). */
export function xTicks(t0: number, t1: number, range: Range, width: number, minGap = 56): XTick[] {
  if (!(t1 > t0) || width <= 0) return [];
  let i = BASE[range];
  if (range === "all" && t1 - t0 < 90 * D) i = 8;
  while (i > 0 && ticksOf(LADDER[i]!, t0, t1).length < 2) i--;
  const step = LADDER[i]!, sx = linear(t0, t1, 0, width);
  const at = (ts: number): XTick => {
    const label = stepLabel(step, range, ts), half = (label.length * 6.6) / 2; // 11px mono ~ 6.6px a glyph
    return { ts, label, x: Math.min(width - half, Math.max(half, sx(ts))) };
  };
  const first = at(t0), last = at(t1), mid: XTick[] = [];
  for (const ts of ticksOf(step, t0, t1)) {
    const t = at(ts), prev = mid.at(-1) ?? first;
    if (t.x - prev.x >= minGap && last.x - t.x >= minGap) mid.push(t);
  }
  return [first, ...mid, last];
}

/** Tooltip time per range: 1D `Oct 20 · 14:05`, 1W `Mon, Oct 20 · 14:00`, 1M `Oct 20 · 14:00`, ALL `Oct 20, 2026` (`Oct 20 · 14:00` under 90 days). */
export function timeLabel(ts: number, range: Range, spanMs = Infinity): string {
  const d = new Date(ts), md = `${MON[d.getMonth()]} ${d.getDate()}`;
  if (range === "1w") return `${DOW[d.getDay()]}, ${md} · ${hm(d)}`;
  if (range === "all" && spanMs >= 90 * D) return `${md}, ${d.getFullYear()}`;
  return `${md} · ${hm(d)}`;
}

// ---- overlays --------------------------------------------------------------------------------------------------------

/** Which right-edge price tags to draw. Two tags closer than `h` px would overlap: the non-preferred one yields. Null y = line hidden. */
export function tagLayout(yYes: number | null, yNo: number | null, prefer: Outcome, h = 18): { yes: boolean; no: boolean } {
  const yes = yYes != null, no = yNo != null;
  if (yes && no && Math.abs(yYes - yNo) < h) return prefer === "NO" ? { yes: false, no: true } : { yes: true, no: false };
  return { yes, no };
}

export type OwnOrder = { price: number; side: "BUY" | "SELL"; outcome: Outcome; shares?: number };
/** An order's price in YES space (a NO order at 41¢ sits at 59¢ on the YES line). */
export const yesPrice = (o: Pick<OwnOrder, "price" | "outcome">) => (o.outcome === "NO" ? 1 - o.price : o.price);
/** `your bid 41.2¢ · 500`; the outcome is named when it is not the one the chart is read in. */
export function orderLabel(o: OwnOrder, tick = 0.01, context: Outcome = "YES"): string {
  const sh = o.shares == null ? "" : ` · ${o.shares.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `your ${o.outcome === context ? "" : `${o.outcome} `}${o.side === "BUY" ? "bid" : "ask"} ${cents(o.price, tick)}${sh}`;
}

// ---- a11y ------------------------------------------------------------------------------------------------------------

export const RANGE_NAME: Record<Range, string> = { "1d": "1 day", "1w": "1 week", "1m": "1 month", all: "all time" };

/** `YES and NO price history, 1 month, YES 6¢, NO 94¢, 312 points` */
export function ariaSummary(range: Range, lastYes: number | null, count: number, tick = 0.01): string {
  const now = lastYes == null ? "" : `, YES ${cents(lastYes, tick)}, NO ${cents(1 - lastYes, tick)}`;
  return `YES and NO price history, ${RANGE_NAME[range]}${now}, ${count} point${count === 1 ? "" : "s"}`;
}

/** First / last / min / max per line for the visually hidden table (percent as ¢). */
export function lineStats(points: readonly HistPt[]): Record<Outcome, { first: number; last: number; min: number; max: number }> | null {
  if (!points.length) return null;
  const ys = points.map((p) => p.mid);
  const yes = { first: ys[0]!, last: ys.at(-1)!, min: Math.min(...ys), max: Math.max(...ys) };
  return { YES: yes, NO: { first: 1 - yes.first, last: 1 - yes.last, min: 1 - yes.max, max: 1 - yes.min } };
}

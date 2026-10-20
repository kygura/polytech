// Pure geometry for OutcomeChart: y-domain, tick steps, time ticks, nearest point. No DOM.

export type Pt = { ts: number; p: number }; // ts = epoch ms, p = YES price 0..1

const STEPS = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25];

/** Price domain covering every value with ~8% headroom, clamped to 0..1 and never narrower than 4¢. */
export function yDomain(values: readonly number[]): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(0.01, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  if (hi - lo < 0.04) { const m = (lo + hi) / 2; lo = m - 0.02; hi = m + 0.02; }
  if (lo < 0) { hi -= lo; lo = 0; }
  if (hi > 1) { lo = Math.max(0, lo - (hi - 1)); hi = 1; }
  return [lo, hi];
}

/** Round-number price ticks inside [lo, hi], about `n` of them. */
export function yTicks(lo: number, hi: number, n = 5): number[] {
  const step = STEPS.find((s) => (hi - lo) / s <= n + 1) ?? 0.25;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e4) / 1e4 + 0); // + 0 turns -0 into 0
  return out;
}

const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const T_STEPS = [5 * MIN, 15 * MIN, 30 * MIN, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D, 91 * D, 182 * D, 365 * D];

/** Time ticks on local-day / round-hour boundaries, about `n` of them. */
export function xTicks(t0: number, t1: number, n = 5): number[] {
  const span = t1 - t0;
  if (!(span > 0)) return [];
  const step = T_STEPS.find((s) => span / s <= n) ?? T_STEPS.at(-1)!;
  const off = step >= D ? new Date(t0).getTimezoneOffset() * MIN : 0; // day steps land on local midnight
  const out: number[] = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) out.push(t);
  return out;
}

const pad2 = (v: number) => String(v).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis label: clock time for spans under two days, else `Oct 12`, else `Oct '25` past a year. */
export function timeLabel(t: number, span: number): string {
  const d = new Date(t);
  if (span < 2 * D) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (span < 400 * D) return `${MON[d.getMonth()]} ${d.getDate()}`;
  return `${MON[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`;
}

/** Tooltip timestamp: `Oct 12, 14:05`. */
export const fullTime = (t: number) => { const d = new Date(t); return `${MON[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/** Index of the point closest in time to `ts` (binary search; `pts` sorted ascending). */
export function nearest(pts: readonly Pt[], ts: number): number {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m]!.ts < ts) lo = m; else hi = m; }
  return Math.abs(pts[lo]!.ts - ts) <= Math.abs(pts[hi]!.ts - ts) ? lo : hi;
}

/** Series sorted by time, the live price appended (or replacing a last point at the same ms). */
export function withLive(pts: readonly Pt[], live: number | null, now: number): Pt[] {
  const out = pts.filter((x) => Number.isFinite(x.p)).slice().sort((a, b) => a.ts - b.ts);
  if (live != null && Number.isFinite(live)) out.push({ ts: Math.max(now, (out.at(-1)?.ts ?? 0) + 1), p: live });
  return out;
}

/** Change over the visible series, in price units (null under two points). */
export const change = (pts: readonly Pt[]) => (pts.length < 2 ? null : pts.at(-1)!.p - pts[0]!.p);

/** SVG path for a series: `x`/`y` map to pixels. A step-after line reads truer for a price that only moves on trades. */
export function linePath(pts: readonly Pt[], x: (t: number) => number, y: (p: number) => number): string {
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const px = x(pts[i]!.ts).toFixed(1), py = y(pts[i]!.p).toFixed(1);
    d += i ? `H${px}V${py}` : `M${px},${py}`;
  }
  return d;
}

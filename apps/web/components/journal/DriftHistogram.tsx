import type { DriftHist } from "./journal";
import { signed5 } from "./journal";
import css from "../charts.module.css";
import j from "./journal.module.css";

const W = 600, H = 200, PAD = { l: 30, r: 10, t: 16, b: 22 };
const cents = (c: number | null) => (c == null ? "—" : `${c < 0 ? "−" : "+"}${Math.abs(c).toFixed(1)}¢`);

/** Move of the mid toward p̂ after the call, 1-cent bins -10..+10: 24h and 7d side by side, dashed means. */
export function DriftHistogram({ hist }: { hist: DriftHist }) {
  const { bins } = hist;
  // No resolved thesis has a drift sample yet: axes alone would render as an empty box with a stray "1" at the top.
  if (hist.n24 + hist.n7 === 0) return <p className="muted ui" style={{ margin: 0 }}>No resolved theses with a price-drift sample yet.</p>;
  const lo = bins[0]!.lo, hi = bins[bins.length - 1]!.hi;
  const max = Math.max(1, ...bins.flatMap((b) => [b.n24, b.n7]));
  const x = (c: number) => PAD.l + ((c - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
  const y = (n: number) => PAD.t + (1 - n / max) * (H - PAD.t - PAD.b);
  const bw = (W - PAD.l - PAD.r) / (hi - lo);
  const mean = (m: number | null, cls: string | undefined, lab: string | undefined, row: number) => m == null ? null : (
    <g>
      <line className={cls} x1={x(Math.max(lo, Math.min(hi, m)))} x2={x(Math.max(lo, Math.min(hi, m)))} y1={PAD.t} y2={H - PAD.b} strokeWidth={1.5} />
      <text className={`${css.label} ${lab}`} x={x(Math.max(lo, Math.min(hi, m))) + 3} y={PAD.t + 4 + row * 11}>{`${row ? "μ7" : "μ24"} ${cents(m)}`}</text>
    </g>
  );
  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Drift toward p̂ histogram, mean 24h ${cents(hist.mean24)}, mean 7d ${cents(hist.mean7)}`}>
        <title>Drift toward p̂, 24h and 7d</title>
        <line className={css.axis} x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} />
        {bins.map((b) => (
          <g key={b.lo}>
            <rect className={j.b24} x={x(b.lo) + 1} y={y(b.n24)} width={Math.max(1, bw / 2 - 1)} height={H - PAD.b - y(b.n24)}><title>{`${signed5(b.lo)}..${signed5(b.hi)}¢ · 24h n=${b.n24}`}</title></rect>
            <rect className={j.b7} x={x(b.lo) + bw / 2} y={y(b.n7)} width={Math.max(1, bw / 2 - 1)} height={H - PAD.b - y(b.n7)}><title>{`${signed5(b.lo)}..${signed5(b.hi)}¢ · 7d n=${b.n7}`}</title></rect>
          </g>
        ))}
        {[-10, -5, 0, 5, 10].filter((c) => c >= lo && c <= hi).map((c) => <text key={c} className={css.label} x={x(c)} y={H - 6} textAnchor="middle">{signed5(c)}</text>)}
        <text className={css.label} x={PAD.l - 4} y={y(max) + 4} textAnchor="end">{max}</text>
        <text className={css.label} x={PAD.l - 4} y={y(0) + 4} textAnchor="end">0</text>
        {mean(hist.mean24, j.mean24, j.lab24, 0)}
        {mean(hist.mean7, j.mean7, j.lab7, 1)}
      </svg>
    </div>
  );
}

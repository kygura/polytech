"use client";
import { useState } from "react";
import css from "./charts.module.css";
import pcss from "./panels.module.css";

export type Bin = { lo: number; hi: number; n: number; meanPredicted: number | null; observed: number | null };
const PAD = { l: 36, r: 10, t: 10, b: 22 };

/** Observed frequency vs predicted p̂, 10 bins, point radius 3–9px ∝ √n. Square viewBox, aspect preserved so points stay round. */
export function ReliabilityChart({ bins, height = 320 }: { bins: Bin[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = height, H = height;
  const pts = bins.filter((b): b is Bin & { meanPredicted: number; observed: number } => b.n > 0 && b.meanPredicted != null && b.observed != null);
  const maxN = Math.max(1, ...pts.map((b) => b.n));
  const x = (p: number) => PAD.l + p * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - p) * (H - PAD.t - PAD.b);
  const r = (n: number) => 3 + 6 * Math.sqrt(n / maxN);
  const h = hover == null ? null : pts[hover]!;
  const total = pts.reduce((t, b) => t + b.n, 0);
  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMid meet" height={height} role="img"
        aria-label={`Reliability chart, ${total} resolved forecasts in ${pts.length} bins`}>
        {[0.25, 0.5, 0.75].map((g) => <g key={g}><line className={css.grid} x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} /><line className={css.grid} x1={x(g)} x2={x(g)} y1={PAD.t} y2={y(0)} /></g>)}
        {[0, 0.5, 1].map((g) => <text key={g} className={css.label} x={PAD.l - 4} y={y(g) + 4} textAnchor="end">{g.toFixed(1)}</text>)}
        {[0, 0.5, 1].map((g) => <text key={g} className={css.label} x={x(g)} y={H - 6} textAnchor="middle">{g.toFixed(1)}</text>)}
        <line className={css.axis} x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        <line className={css.axis} x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={y(0)} />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--faint)" strokeDasharray="4 4" />
        {pts.map((b, i) => (
          <circle key={i} cx={x(b.meanPredicted)} cy={y(b.observed)} r={r(b.n)} fill="var(--accent)" fillOpacity={0.7} stroke="var(--accent)"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <title>{`p̂ ${b.meanPredicted.toFixed(2)} · observed ${b.observed.toFixed(2)} · n=${b.n}`}</title>
          </circle>
        ))}
      </svg>
      {h && <div className={css.tip} style={{ left: `${(x(h.meanPredicted) / W) * 100}%`, top: y(h.observed) - 24 }}>{`n=${h.n} · p̂ ${h.meanPredicted.toFixed(2)} · obs ${h.observed.toFixed(2)}`}</div>}
      <details className={pcss.bins}>
        <summary>bins as text</summary>
        <table aria-label="reliability bins">
          <thead><tr><th scope="col">Bin</th><th scope="col" className="num">n</th><th scope="col" className="num">mean p̂</th><th scope="col" className="num">observed</th></tr></thead>
          <tbody>{bins.map((b) => <tr key={b.lo}><td>{b.lo.toFixed(1)}–{b.hi.toFixed(1)}</td><td className="num">{b.n}</td><td className="num">{b.meanPredicted?.toFixed(3) ?? "—"}</td><td className="num">{b.observed?.toFixed(3) ?? "—"}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

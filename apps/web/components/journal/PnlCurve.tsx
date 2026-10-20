"use client";
import { useId, useState, type MouseEvent } from "react";
import { fmt, mmdd } from "../fmt";
import css from "../charts.module.css";
import j from "./journal.module.css";
import { nearestIndex } from "./journal";

export type PnlPoint = { t: string; pnl: number; cum: number };
const W = 600, H = 220, PAD = { l: 52, r: 10, t: 10, b: 22 };

/** Cumulative paper P&L by resolution date: step line, area to zero tinted by sign. */
export function PnlCurve({ series }: { series: PnlPoint[] }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  if (!series.length) return <p className="muted ui" style={{ margin: 0 }}>No staked, resolved theses yet.</p>;
  const ts = series.map((p) => new Date(p.t).getTime());
  const [t0, t1] = [ts[0]!, ts[ts.length - 1]!];
  const lo = Math.min(0, ...series.map((p) => p.cum)), hi = Math.max(0, ...series.map((p) => p.cum));
  const span = hi - lo || 1;
  const x = (t: number) => (t1 === t0 ? (PAD.l + W - PAD.r) / 2 : PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + ((hi - v) / span) * (H - PAD.t - PAD.b);
  const y0 = y(0);
  const pts = series.map((p, i) => [x(ts[i]!), y(p.cum)] as const);
  const line = pts.map(([px, py], i) => (i === 0 ? `M${px},${py}` : `H${px}V${py}`)).join("");
  const area = `${line}L${pts[pts.length - 1]![0]},${y0}L${pts[0]![0]},${y0}Z`;
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(pts.map(([px]) => px), ((e.clientX - b.left) / b.width) * W));
  };
  const h = hover == null ? null : series[hover]!;
  const last = series[series.length - 1]!;
  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cumulative paper P&L, ${series.length} resolved theses, ending ${fmt(last.cum, "usd", true)} dollars`}
        onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <title>Cumulative paper P&amp;L</title>
        <defs>
          <clipPath id={`${id}a`}><rect x={0} y={0} width={W} height={y0} /></clipPath>
          <clipPath id={`${id}b`}><rect x={0} y={y0} width={W} height={H - y0} /></clipPath>
        </defs>
        <path d={area} className={j.pos15} clipPath={`url(#${id}a)`} />
        <path d={area} className={j.neg15} clipPath={`url(#${id}b)`} />
        <line className={j.zero} x1={PAD.l} x2={W - PAD.r} y1={y0} y2={y0} />
        <path d={line} className={j.pnlLine} />
        {[hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i).map((v) => <text key={v} className={css.label} x={PAD.l - 4} y={y(v) + 4} textAnchor="end">{`$${fmt(v, "usd", v !== 0)}`}</text>)}
        <text className={css.label} x={PAD.l} y={H - 6}>{mmdd(t0)}</text>
        <text className={css.label} x={W - PAD.r} y={H - 6} textAnchor="end">{mmdd(t1)}</text>
        {h && <circle cx={pts[hover!]![0]} cy={pts[hover!]![1]} r={3} fill="var(--text)" />}
      </svg>
      {h && <div className={css.tip} style={{ left: `${(pts[hover!]![0] / W) * 100}%`, top: 0 }}>{`${mmdd(ts[hover!]!)} · ${fmt(h.cum, "usd", true)} · n ${hover! + 1}`}</div>}
    </div>
  );
}

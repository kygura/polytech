"use client";
import { useState, type MouseEvent } from "react";
import { fmt, mmdd } from "../fmt";
import css from "../charts.module.css";
import j from "./journal.module.css";
import { nearestIndex, type RollingPoint } from "./journal";

const W = 600, H = 200, PAD = { l: 40, r: 10, t: 10, b: 22 };

/** Rolling-20 Brier: model (solid), market (dashed), pre-reveal (dotted); fill between model and market tinted by which is lower. */
export function BrierCompareChart({ points }: { points: RollingPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.flatMap((p) => [p.model, p.market, ...(p.pre != null ? [p.pre] : [])]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 0.01;
  const n = points.length;
  const x = (i: number) => (n === 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + ((hi - v) / span) * (H - PAD.t - PAD.b);
  const path = (f: (p: RollingPoint) => number | null) => points.flatMap((p, i) => { const v = f(p); return v == null ? [] : [[x(i), y(v)] as const]; }).map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
  // Fill model-vs-market segment by segment so each polygon is tinted by the sign of the gap (crossings approximated at the vertices).
  const fills = points.slice(1).map((p, i) => {
    const q = points[i]!;
    const better = (q.model + p.model) / 2 <= (q.market + p.market) / 2;
    return <path key={i} className={better ? j.pos15 : j.neg15} d={`M${x(i)},${y(q.model)}L${x(i + 1)},${y(p.model)}L${x(i + 1)},${y(p.market)}L${x(i)},${y(q.market)}Z`} />;
  });
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(points.map((_, i) => x(i)), ((e.clientX - b.left) / b.width) * W));
  };
  const h = hover == null ? null : points[hover]!;
  const last = points[n - 1]!;
  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rolling ${20}-thesis Brier, model ${last.model.toFixed(3)} vs market ${last.market.toFixed(3)}, ${n} points`}
        onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <title>Rolling Brier: model vs market vs pre-reveal</title>
        {[lo, (lo + hi) / 2, hi].map((v) => <g key={v}><line className={css.grid} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} /><text className={css.label} x={PAD.l - 4} y={y(v) + 4} textAnchor="end">{v.toFixed(3)}</text></g>)}
        {fills}
        <path d={path((p) => p.market)} className={j.lineMarket} />
        <path d={path((p) => p.pre)} className={j.linePre} />
        <path d={path((p) => p.model)} className={j.lineModel} />
        <text className={css.label} x={PAD.l} y={H - 6}>{mmdd(points[0]!.t)}</text>
        <text className={css.label} x={W - PAD.r} y={H - 6} textAnchor="end">{mmdd(last.t)}</text>
      </svg>
      {h && <div className={css.tip} style={{ left: `${(x(hover!) / W) * 100}%`, top: 0 }}>{`${mmdd(h.t)} · model ${fmt(h.model, "p")} · mkt ${fmt(h.market, "p")} · pre ${fmt(h.pre, "p")}`}</div>}
    </div>
  );
}

"use client";
import { useState } from "react";
import { fmt, hm, mmdd } from "./fmt";
import css from "./charts.module.css";

type Pt = { ts: number; mid: number | null };
type Marker = { ts: number; pHat: number; side: "YES" | "NO" };
const W = 1000, PAD = { l: 36, r: 8, t: 8, b: 18 };

/** Mid line over snapshot history, y 0–1, thesis markers as dashed verticals. */
export function PriceHistoryChart({ series, markers, height = 180, empty = "No price history yet" }: { series: Pt[]; markers: Marker[]; height?: number; empty?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.filter((p): p is { ts: number; mid: number } => p.mid != null);
  if (pts.length < 2) return <div className="muted" style={{ height }}>{empty}</div>;
  const t0 = pts[0]!.ts, t1 = pts[pts.length - 1]!.ts, span = t1 - t0 || 1;
  const x = (ts: number) => PAD.l + ((ts - t0) / span) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - p) * (height - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.mid).toFixed(1)}`).join("");
  const last = pts[pts.length - 1]!;
  const h = hover == null ? null : pts[hover]!;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ts = t0 + ((e.clientX - r.left) / r.width) * span;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.ts - ts) < Math.abs(pts[best]!.ts - ts)) best = i;
    setHover(best);
  };

  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" height={height} role="img"
        aria-label={`Price history, ${pts.length} points, last mid ${fmt(last.mid, "p")}, ${markers.length} theses`}>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} className={css.grid} x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} />)}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => <text key={g} className={css.label} x={PAD.l - 4} y={y(g) + 4} textAnchor="end">{g.toFixed(2)}</text>)}
        <line className={css.axis} x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        <text className={css.label} x={PAD.l} y={height - 4}>{mmdd(t0)}</text>
        <text className={css.label} x={W - PAD.r} y={height - 4} textAnchor="end">{mmdd(t1)}</text>
        <path d={path} fill="none" stroke="var(--text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {markers.filter((m) => m.ts >= t0 && m.ts <= t1).map((m, i) => (
          <g key={i} stroke={m.side === "YES" ? "var(--pos)" : "var(--neg)"}>
            <line x1={x(m.ts)} x2={x(m.ts)} y1={PAD.t} y2={y(0)} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <text className={css.label} x={x(m.ts) + 3} y={y(m.pHat) - 3} stroke="none" fill={m.side === "YES" ? "var(--pos)" : "var(--neg)"}>p̂ {m.pHat.toFixed(2)}</text>
          </g>
        ))}
        {h && <circle cx={x(h.ts)} cy={y(h.mid)} r={3} fill="var(--accent)" />}
        <rect x={0} y={0} width={W} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h && <div className={css.tip} style={{ left: `${(x(h.ts) / W) * 100}%`, top: 0 }}>{mmdd(h.ts)} {hm(h.ts)} {"·"} {fmt(h.mid, "p")}</div>}
    </div>
  );
}

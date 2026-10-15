export function Sparkline({ points, width = 80, height = 18, label }: { points: number[]; width?: number; height?: number; label?: string }) {
  if (points.length < 2) return null;
  const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
  const d = points.map((p, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${(height - 1 - ((p - lo) / span) * (height - 2)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `sparkline, last ${points[points.length - 1]}`}>
      <polyline points={d} fill="none" stroke="var(--muted)" strokeWidth={1} />
    </svg>
  );
}

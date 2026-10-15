import { fmt } from "./fmt";
import css from "./charts.module.css";

type Level = { price: number; size: number };
const W = 1000, PAD = { l: 8, r: 8, t: 8, b: 18 };

/** Cumulative bids (left, --pos) and asks (right, --neg) from the latest book; text levels below so nothing is chart-only. */
export function DepthChart({ bids, asks, mid, k, height = 140 }: { bids: Level[]; asks: Level[]; mid: number | null; k?: number | null; height?: number }) {
  const B = [...bids].sort((a, b) => b.price - a.price), A = [...asks].sort((a, b) => a.price - b.price);
  const cum = (ls: Level[]) => { let t = 0; return ls.map((l) => ({ price: l.price, usd: (t += l.price * l.size) })); };
  const cb = cum(B), ca = cum(A);
  const prices = [...B, ...A].map((l) => l.price).concat(mid ?? [], k ?? []);
  if (!prices.length) return <div className="muted" style={{ height }}>No book snapshot</div>;
  const lo = Math.min(...prices), hi = Math.max(...prices), span = hi - lo || 0.01;
  const maxUsd = Math.max(1, ...cb.map((l) => l.usd), ...ca.map((l) => l.usd));
  const x = (p: number) => PAD.l + ((p - lo) / span) * (W - PAD.l - PAD.r);
  const y = (u: number) => PAD.t + (1 - u / maxUsd) * (height - PAD.t - PAD.b);
  const step = (ls: { price: number; usd: number }[], dir: 1 | -1) => {
    if (!ls.length) return "";
    const pts = ls.flatMap((l, i) => (i ? [`${x(l.price)},${y(ls[i - 1]!.usd)}`] : []).concat(`${x(l.price)},${y(l.usd)}`));
    const first = ls[0]!, last = ls[ls.length - 1]!;
    return `M${x(first.price)},${y(0)} L${x(first.price)},${y(first.usd)} L${pts.join(" L")} L${x(last.price) + dir * 0},${y(last.usd)} L${x(last.price)},${y(0)} Z`;
  };
  const within5 = bids.filter((b) => mid != null && b.price >= mid - 0.05).reduce((t, b) => t + b.price * b.size, 0);
  const marker = (p: number, color: string, label: string) => (
    <g>
      <line x1={x(p)} x2={x(p)} y1={PAD.t} y2={y(0)} stroke={color} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <text className={css.label} x={x(p) + 3} y={PAD.t + 10} fill={color}>{label}</text>
    </g>
  );
  return (
    <div className={css.chart}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" height={height} role="img"
        aria-label={`Depth chart, mid ${fmt(mid, "p")}, bids $${fmt(within5, "usd")} within 5 cents`}>
        <path d={step(cb, -1)} fill="var(--pos)" fillOpacity={0.25} stroke="var(--pos)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={step(ca, 1)} fill="var(--neg)" fillOpacity={0.25} stroke="var(--neg)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line className={css.axis} x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {mid != null && marker(mid, "var(--muted)", `mid ${mid.toFixed(3)}`)}
        {k != null && marker(k, "var(--accent)", `k ${k.toFixed(3)}`)}
        <text className={css.label} x={PAD.l} y={height - 4}>{lo.toFixed(3)}</text>
        <text className={css.label} x={W - PAD.r} y={height - 4} textAnchor="end">{hi.toFixed(3)}</text>
      </svg>
      <div className={css.levels}>
        <Levels title="bids" levels={B.slice(0, 8)} />
        <Levels title="asks" levels={A.slice(0, 8)} />
      </div>
    </div>
  );
}

function Levels({ title, levels }: { title: string; levels: Level[] }) {
  return (
    <table aria-label={`top ${title}`}>
      <thead><tr><th scope="col">{title}</th><th scope="col" className="num">size</th></tr></thead>
      <tbody>
        {levels.length ? levels.map((l, i) => <tr key={i}><td className="num" style={{ textAlign: "left" }}>{l.price.toFixed(3)}</td><td className="num">{fmt(l.size, "int")}</td></tr>)
          : <tr><td colSpan={2} className="muted">{"—"}</td></tr>}
      </tbody>
    </table>
  );
}

"use client";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { fullTime, linePath, nearest, timeLabel, withLive, xTicks, yDomain, yTicks, type Pt } from "./scale";
import css from "./OutcomeChart.module.css";

export type Show = "both" | "YES" | "NO";
/** A horizontal price line in one outcome's own price (an open order, a target). */
export type Level = { key: string; p: number; outcome: "YES" | "NO"; label: string };
/** A vertical event line (a thesis), `p` the YES-space value to label it at. */
export type Marker = { ts: number; p: number; label: string; outcome: "YES" | "NO" };

const M = { l: 8, r: 58, t: 12, b: 24 };
const cents = (p: number) => { const c = p * 100; return `${Math.abs(c - Math.round(c)) < 0.05 ? Math.round(c) : c.toFixed(1)}¢`; };

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [s, set] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => set({ w: Math.floor(e!.contentRect.width), h: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, s] as const;
}

type Props = {
  /** YES prices; NO is drawn as 1 − YES. */
  points: readonly Pt[];
  live?: number | null;
  show?: Show;
  levels?: readonly Level[];
  markers?: readonly Marker[];
  /** Fixed height in px; omit to fill the parent (which then needs a height). */
  height?: number;
  empty?: string;
  now?: number;
  className?: string;
};

/** YES and NO price lines on one 0–100¢ axis: time axis, crosshair with both prices, last-price tags, optional order lines and markers. */
export function OutcomeChart({ points, live = null, show = "both", levels = [], markers = [], height, empty = "No price history yet.", now = Date.now(), className }: Props) {
  const [ref, { w: W, h: measured }] = useSize<HTMLDivElement>();
  const H = height ?? measured;
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const yes = withLive(points, live, now);
  const w = W - M.l - M.r, h = H - M.t - M.b;
  const ok = yes.length >= 2 && w > 60 && h > 40;

  let body = null, tip = null;
  if (ok) {
    const showYes = show !== "NO", showNo = show !== "YES";
    const no = yes.map((x) => ({ ts: x.ts, p: 1 - x.p }));
    const vals = [...(showYes ? yes.map((x) => x.p) : []), ...(showNo ? no.map((x) => x.p) : []), ...levels.map((l) => l.p)];
    const [lo, hi] = yDomain(vals);
    const t0 = yes[0]!.ts, t1 = yes.at(-1)!.ts, span = t1 - t0 || 1;
    const x = (t: number) => M.l + ((t - t0) / span) * w, y = (p: number) => M.t + (1 - (p - lo) / (hi - lo)) * h;
    const lastY = yes.at(-1)!.p, lastN = 1 - lastY;
    // last-price tags: keep 18px apart when both are shown
    let tagY = y(lastY), tagN = y(lastN);
    if (showYes && showNo && Math.abs(tagY - tagN) < 18) { const m = (tagY + tagN) / 2, s = tagY <= tagN ? -9 : 9; tagY = m + s; tagN = m - s; }
    const i = hover == null ? null : Math.min(hover, yes.length - 1);
    const hp = i == null ? null : yes[i]!;
    const area = (s: Pt[]) => `${linePath(s, x, y)}V${M.t + h}H${M.l}Z`;
    const primary = showYes ? yes : no;

    body = (
      <svg width={W} height={H} className={css.svg} aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={showYes ? "var(--oc-yes)" : "var(--oc-no)"} stopOpacity=".18" />
            <stop offset="1" stopColor={showYes ? "var(--oc-yes)" : "var(--oc-no)"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks(lo, hi).map((v) => (
          <g key={v}>
            <line className={css.grid} x1={M.l} x2={M.l + w} y1={y(v)} y2={y(v)} />
            {!((showYes && Math.abs(y(v) - tagY) < 13) || (showNo && Math.abs(y(v) - tagN) < 13)) && <text className={css.ax} x={M.l + w + 8} y={y(v) + 4}>{cents(v)}</text>}
          </g>
        ))}
        {xTicks(t0, t1, Math.max(2, Math.floor(w / 110))).map((t) => (
          <g key={t}>
            <line className={css.tick} x1={x(t)} x2={x(t)} y1={M.t + h} y2={M.t + h + 4} />
            <text className={css.ax} x={x(t)} y={H - 6} textAnchor="middle">{timeLabel(t, span)}</text>
          </g>
        ))}
        <line className={css.base} x1={M.l} x2={M.l + w} y1={M.t + h} y2={M.t + h} />
        <path d={area(primary)} fill={`url(#${gid})`} />
        {showNo && <path d={linePath(no, x, y)} className={css.no} />}
        {showYes && <path d={linePath(yes, x, y)} className={css.yes} />}
        {markers.filter((m) => m.ts >= t0 && m.ts <= t1).map((m, k) => (
          <g key={k} className={m.outcome === "YES" ? css.mYes : css.mNo}>
            <line x1={x(m.ts)} x2={x(m.ts)} y1={M.t} y2={M.t + h} strokeDasharray="3 3" />
            <text x={x(m.ts) + 4} y={M.t + 10}>{m.label}</text>
          </g>
        ))}
        {levels.map((l) => (
          <g key={l.key} className={css.level}>
            <line x1={M.l} x2={M.l + w} y1={y(l.p)} y2={y(l.p)} strokeDasharray="4 4" />
            <text x={M.l + 6} y={y(l.p) - 5}>{l.label}</text>
          </g>
        ))}
        {showYes && <g className={css.tagYes}><rect x={M.l + w + 3} y={tagY - 9} width={M.r - 6} height={18} rx={4} /><text x={M.l + w + 8} y={tagY + 4}>{cents(lastY)}</text></g>}
        {showNo && <g className={css.tagNo}><rect x={M.l + w + 3} y={tagN - 9} width={M.r - 6} height={18} rx={4} /><text x={M.l + w + 8} y={tagN + 4}>{cents(lastN)}</text></g>}
        {hp && (
          <g>
            <line className={css.cross} x1={x(hp.ts)} x2={x(hp.ts)} y1={M.t} y2={M.t + h} />
            {showYes && <circle cx={x(hp.ts)} cy={y(hp.p)} r={3.5} className={css.dotYes} />}
            {showNo && <circle cx={x(hp.ts)} cy={y(1 - hp.p)} r={3.5} className={css.dotNo} />}
          </g>
        )}
      </svg>
    );
    if (hp) {
      const left = x(hp.ts), flip = left > W - 170;
      tip = (
        <div className={css.tip} style={{ left: flip ? undefined : left + 12, right: flip ? W - left + 12 : undefined, top: M.t }}>
          <div className={css.tipT}>{fullTime(hp.ts)}{i === yes.length - 1 && live != null ? " · live" : ""}</div>
          {showYes && <div><i className={css.swYes} />YES <b>{cents(hp.p)}</b></div>}
          {showNo && <div><i className={css.swNo} />NO <b>{cents(1 - hp.p)}</b></div>}
        </div>
      );
    }
    const onMove = (e: PointerEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setHover(nearest(yes, t0 + ((e.clientX - r.left - M.l) / w) * span));
    };
    return (
      <div ref={ref} className={`${css.wrap} ${className ?? ""}`} style={height ? { height } : undefined} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        role="img" aria-label={`Price history, ${yes.length} points. YES ${cents(lastY)}, NO ${cents(lastN)}.`}>
        {body}{tip}
      </div>
    );
  }
  return (
    <div ref={ref} className={`${css.wrap} ${className ?? ""}`} style={height ? { height } : undefined}>
      {W > 0 && <p className={css.empty}>{yes.length < 2 ? empty : ""}</p>}
    </div>
  );
}

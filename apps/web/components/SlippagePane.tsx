"use client";
import { useState } from "react";
import { usePoll } from "../hooks/usePoll";
import { feedUrl } from "../hooks/useMarketFeed";
import { MarketFeedSchema } from "../lib/feed";
import { hm } from "./fmt";
import { Segmented } from "./Segmented";
import { ariaLabel, capLabel, curveOf, readout, sizeAt, usdLabel, X_MAX, X_MIN, X_TICKS, xFrac, yFrac, Y_SPAN, type Side } from "./slippage";
import charts from "./charts.module.css";
import css from "./detail.module.css";

type Level = { price: number; size: number };
const W = 1000, PAD = { l: 44, r: 8, t: 12, b: 18 };
const SIDES = [{ value: "YES", label: "YES" }, { value: "NO", label: "NO" }] as const;
const LIVE_MS = 15_000;

/**
 * DESIGN 12.6.3: average fill price vs order size (log x) on the live book (public feed, 15 levels), else the latest snapshot's.
 * `defaultSide` = the thesis side, else YES; NO is the complement book.
 */
export function SlippagePane({ conditionId, snapshot, defaultSide, height = 140 }: { conditionId: string; snapshot: { ts: number; bids: Level[]; asks: Level[] } | null; defaultSide: Side; height?: number }) {
  const [side, setSide] = useState<Side>(defaultSide);
  const [hover, setHover] = useState<number | null>(null); // size fraction 0..1 on the log axis
  const live = usePoll<unknown>(feedUrl(conditionId), LIVE_MS);
  const parsed = live.data == null ? null : MarketFeedSchema.safeParse(live.data);
  const src = parsed?.success ? { bids: parsed.data.bids, asks: parsed.data.asks, label: `live ${hm(parsed.data.at)}` } : snapshot ? { bids: snapshot.bids, asks: snapshot.asks, label: `snapshot ${hm(snapshot.ts)}` } : null;
  const book = src && { bids: src.bids, asks: src.asks };
  const c = book ? curveOf(book, side) : null;

  const pw = W - PAD.l - PAD.r, ph = height - PAD.t - PAD.b;
  const x = (f: number) => PAD.l + f * pw, y = (f: number) => PAD.t + (1 - f) * ph;
  const body = !c || !book ? <div className="muted" style={{ height }}>Not enough depth for a curve.</div> : (() => {
    const path = c.points.map((p, i) => `${i ? "L" : "M"}${x(xFrac(p.size)).toFixed(1)},${y(yFrac(p.vwap, c.ask)).toFixed(1)}`).join("");
    const size = hover == null ? null : sizeAt(hover);
    const hp = size == null ? null : (c.points.find((p) => p.size >= size) ?? null);
    const tip = size == null ? null : readout(book, side, size);
    const onMove = (e: React.MouseEvent<SVGRectElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setHover(Math.min(1, Math.max(0, ((((e.clientX - r.left) / r.width) * W) - PAD.l) / pw)));
    };
    return (
      <div className={charts.chart}>
        <svg className={charts.svg} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label={ariaLabel(side, c)}>
          {X_TICKS.map((t) => (
            <g key={t}>
              <line className={charts.grid} x1={x(xFrac(t))} x2={x(xFrac(t))} y1={PAD.t} y2={y(0)} />
              <text className={charts.label} x={x(xFrac(t))} y={height - 4} textAnchor={t === X_MAX ? "end" : t === X_MIN ? "start" : "middle"}>{usdLabel(t)}</text>
            </g>
          ))}
          <line className={charts.axis} x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
          <text className={charts.label} x={PAD.l - 4} y={y(0) + 4} textAnchor="end">{c.ask.toFixed(3)}</text>
          <text className={charts.label} x={PAD.l - 4} y={y(1) + 4} textAnchor="end">{(c.ask + Y_SPAN).toFixed(3)}</text>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          <text className={charts.label} x={W - PAD.r} y={y(0) - 3} textAnchor="end">ask {c.ask.toFixed(3)}</text>
          {c.caps.map((k, i) => k.usd >= X_MIN && k.usd <= X_MAX && (
            <g key={k.cents}>
              <line x1={x(xFrac(k.usd))} x2={x(xFrac(k.usd))} y1={PAD.t} y2={y(0)} stroke="var(--faint)" strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
              <text className={charts.label} x={x(xFrac(k.usd)) + (xFrac(k.usd) > 0.8 ? -3 : 3)} y={PAD.t + 9 + i * 11} textAnchor={xFrac(k.usd) > 0.8 ? "end" : "start"}>{capLabel(k)}</text>
            </g>
          ))}
          <path d={path} fill="none" stroke="var(--text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {hp && <circle cx={x(xFrac(hp.size))} cy={y(yFrac(hp.vwap, c.ask))} r={3} fill="var(--accent)" />}
          <rect x={0} y={0} width={W} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {tip && hover != null && <div className={charts.tip} style={{ left: `${(x(hover) / W) * 100}%`, top: 0 }}>{tip}</div>}
        <div className={css.slipNote}>
          <span><b>capacity</b>{c.caps.map(capLabel).join(" · ")}</span>
          <span><b>book</b>{src!.label}</span>
        </div>
      </div>
    );
  })();

  return (
    <section className="pane">
      <h2 className={css.titleRow}>
        <span>Slippage</span>
        <Segmented label="Slippage side" options={SIDES} value={side} onChange={setSide} />
      </h2>
      <div className="body">{body}</div>
    </section>
  );
}

"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { OpenOrder } from "@pm/pm/exchange";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import type { PublicMarketDetail } from "../../lib/public";
import { DEFAULT_TICK } from "../public/ticket";
import { cents, sh, usdShort, type Outcome } from "./book";
import css from "./terminal.module.css";

type Meta = { conditionId: string; question: string; category: string | null; endDate: number | null; daysLeft: number };
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** `yesMid` = feed.mid ?? snapshot mid; NO = 1 − YES. The outcome cards are the mouse equivalent of Y / N. */
export function MarketHero({ meta, tick, yesMid, outcome, onOutcome, notFound }: { meta: Meta | null; tick: number | null; yesMid: number | null; outcome: Outcome; onOutcome: (o: Outcome) => void; notFound: boolean }) {
  const t = tick ?? DEFAULT_TICK;
  return (
    <div className={css.hero}>
      <div>
        <h1>{meta?.question ?? (notFound ? "This market is not on the public list." : "Loading market…")}</h1>
        {meta && (
          <div className={css.meta}>
            {meta.category ?? "—"} · ends {meta.endDate ? day(meta.endDate) : "—"} · {Math.max(0, Math.round(meta.daysLeft))} days · <span className={css.n}>tick {tick == null ? "—" : `${cents(tick, tick)}¢`}</span> ·{" "}
            <a href={`https://polymarket.com/market/${meta.conditionId}`} target="_blank" rel="noreferrer">Polymarket ↗</a>
          </div>
        )}
      </div>
      <div className={css.out}>
        {(["YES", "NO"] as const).map((o) => {
          const p = yesMid == null ? null : o === "YES" ? yesMid : 1 - yesMid;
          return (
            <button key={o} type="button" aria-pressed={outcome === o} className={o === "YES" ? css.y : css.nn} onClick={() => onOutcome(o)}>
              <span className={css.lbl}><span>{o}</span><kbd>{o[0]}</kbd></span>
              <span className={`${css.big} ${o === "YES" ? css.yes : css.no}`}>{p == null ? "—" : `${cents(p, t)}¢`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** `book` is the chosen outcome's (mirrored for NO). */
export function KeyStats({ book, vol24h }: { book: MarketFeed | null; vol24h: number | null }) {
  const t = book?.tickSize ?? DEFAULT_TICK, bid = book?.bids[0]?.price ?? null, ask = book?.asks[0]?.price ?? null;
  const cell = (label: string, v: string, cls = "") => <div><span className={css.lbl}>{label}</span><span className={`${css.n} ${cls}`}>{v}</span></div>;
  const c = (p: number | null) => (p == null ? "—" : `${cents(p, t)}¢`);
  return (
    <div className={css.stats}>
      {cell("Last", c(book?.last ?? null))}
      {cell("Best bid", c(bid), css.up)}
      {cell("Best ask", c(ask), css.down)}
      {cell("Spread", bid == null || ask == null ? "—" : `${cents(ask - bid, t)}¢`)}
      {cell("Min order", book?.minOrderSize == null ? "—" : `${sh(book.minOrderSize)} sh`)}
      {cell("Vol 24h", vol24h == null ? "—" : usdShort(vol24h))}
    </div>
  );
}

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

/** History from the detail snapshots (YES mids), the live mid appended; one dashed line per own open order on this outcome's token. */
export function PriceChart({ history, liveMid, ownOrders, outcome, tick }: { history: PublicMarketDetail["history"]; liveMid: number | null; ownOrders: OpenOrder[]; outcome: Outcome; tick: number }) {
  const [ref, { w: W, h: H }] = useSize<HTMLDivElement>();
  const gid = useId();
  const pts = history.filter((x): x is { ts: number; mid: number } => x.mid != null).map((x) => ({ t: x.ts, p: x.mid }));
  if (liveMid != null) pts.push({ t: Math.max(Date.now(), (pts.at(-1)?.t ?? 0) + 1), p: liveMid });
  const series = outcome === "YES" ? pts : pts.map((x) => ({ t: x.t, p: 1 - x.p }));
  const color = outcome === "YES" ? "var(--t-yes)" : "var(--t-no)", onColor = outcome === "YES" ? "var(--t-on-yes)" : "var(--t-on-no)";
  const w = W - 64, h = H - 56;
  let svg = null;
  if (series.length >= 2 && w > 40 && h > 40) {
    const ps = [...series.map((x) => x.p), ...ownOrders.map((o) => o.price)];
    let lo = Math.min(...ps), hi = Math.max(...ps);
    const pad = Math.max(0.01, (hi - lo) * 0.1);
    lo = Math.max(0, lo - pad); hi = Math.min(1, hi + pad);
    const t0 = series[0]!.t, t1 = series.at(-1)!.t;
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * w, y = (v: number) => 16 + h - ((v - lo) / (hi - lo)) * h;
    const line = series.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.p).toFixed(1)}`).join("");
    const grid = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * (i + 0.5)) / 5);
    const last = series.at(-1)!.p;
    svg = (
      <svg width={w + 60} height={h + 44} style={{ marginTop: 8 }} role="img" aria-label={`${outcome} price history, last ${cents(last, tick)} cents`}>
        <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {grid.map((v) => (
          <g key={v}>
            <line x1="0" x2={w} y1={y(v)} y2={y(v)} stroke="var(--t-line)" />
            <text x={w + 10} y={y(v) + 4} fill="var(--t-dim)" fontSize="11" fontFamily="var(--t-font-num)">{cents(v, tick)}¢</text>
          </g>
        ))}
        <path d={`${line}L${w},${h + 16}L0,${h + 16}Z`} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.6" />
        {ownOrders.map((o) => (
          <g key={o.orderId}>
            <line x1="0" x2={w} y1={y(o.price)} y2={y(o.price)} stroke="var(--t-focus)" strokeDasharray="4 4" />
            <text x="8" y={y(o.price) - 5} fill="var(--t-focus)" fontSize="11" fontFamily="var(--t-font-num)">your {o.side === "BUY" ? "bid" : "ask"} {cents(o.price, tick)}¢ · {sh(o.shares - o.filled)}</text>
          </g>
        ))}
        <rect x={w + 4} y={y(last) - 10} width="50" height="20" rx="4" fill={color} />
        <text x={w + 9} y={y(last) + 4} fill={onColor} fontSize="11.5" fontWeight="600" fontFamily="var(--t-font-num)">{cents(last, tick)}¢</text>
        <text x="0" y={h + 38} fill="var(--t-dim)" fontSize="10.5" fontFamily="var(--t-font-num)">price history from snapshots · live tail from feed</text>
      </svg>
    );
  }
  return (
    <div ref={ref} className={css.chart}>
      {svg ?? (W > 0 && <p className={`${css.line} ${css.msg}`}>{series.length < 2 ? "No price history yet." : ""}</p>)}
    </div>
  );
}

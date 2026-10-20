"use client";
import { useEffect, useRef, useState } from "react";
import type { OpenOrder } from "@pm/pm/exchange";
import { inInput } from "../../hooks/useGlobalKeys";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import { usePoll } from "../../hooks/usePoll";
import { RANGES, type HistoryResult, type Range } from "../../lib/history";
import { OutcomeChart, type Show } from "../chart/OutcomeChart";
import { change, withLive } from "../chart/scale";
import { stepRange } from "../PriceHistoryPane";
import type { PublicMarketDetail } from "../../lib/public";
import { DEFAULT_TICK } from "../public/ticket";
import { cents, sh, usdShort, type Outcome } from "./book";
import css from "./terminal.module.css";

type Meta = { conditionId: string; question: string; category: string | null; endDate: number | null; daysLeft: number };
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** `yesMid` = feed.mid ?? snapshot mid; NO = 1 − YES. The outcome cards are the mouse equivalent of Y / N. The title always wraps in full. */
export function MarketHero({ meta, tick, yesMid, outcome, onOutcome, notFound }: { meta: Meta | null; tick: number | null; yesMid: number | null; outcome: Outcome; onOutcome: (o: Outcome) => void; notFound: boolean }) {
  const t = tick ?? DEFAULT_TICK;
  return (
    <div className={css.hero}>
      <h1>{meta?.question ?? (notFound ? "This market is not on the public list." : "Loading market…")}</h1>
      <div className={css.heroRow}>
        <div className={css.heroLeft}>
          {meta && (
            <div className={css.meta}>
              {meta.category && `${meta.category} · `}ends {meta.endDate ? day(meta.endDate) : "—"} · {Math.max(0, Math.round(meta.daysLeft))} days · <span className={css.n}>tick {tick == null ? "—" : `${cents(tick, tick)}¢`}</span> ·{" "}
              <a href={`https://polymarket.com/market/${meta.conditionId}`} target="_blank" rel="noreferrer">Polymarket ↗</a>
            </div>
          )}
          <div className={css.prob} role="img" aria-label={yesMid == null ? "no price" : `YES ${Math.round(yesMid * 100)} percent, NO ${Math.round((1 - yesMid) * 100)} percent`}>
            <span className={css.probY} style={{ width: `${yesMid == null ? 50 : yesMid * 100}%` }} />
            <span className={css.probN} />
          </div>
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

const RANGE_OPTS = RANGES.map((r) => ({ value: r, label: r === "all" ? "All" : r.toUpperCase() }));
const SHOW_OPTS = [{ value: "both", label: "Both" }, { value: "YES", label: "Yes" }, { value: "NO", label: "No" }] as const;
const SPAN: Record<Range, string> = { "1d": "1D", "1w": "1W", "1m": "1M", all: "all time" };

/** Small radiogroup in terminal style. */
function Seg<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={css.cseg}>
      {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/** Polymarket price history for the range (falls back to our snapshots), YES and NO lines, the live mid as the tail; one dashed line per own open order. `[` / `]` step the range. */
export function PriceChart({ conditionId, fallback, liveMid, ownOrders, outcome }: { conditionId: string | null; fallback: PublicMarketDetail["history"]; liveMid: number | null; ownOrders: OpenOrder[]; outcome: Outcome }) {
  const [range, setRange] = useState<Range>("1w");
  const [show, setShow] = useState<Show>("both");
  const h = usePoll<HistoryResult>(conditionId ? `/api/markets/${encodeURIComponent(conditionId)}/history?range=${range}` : null, 60_000);
  const cur = useRef(range);
  cur.current = range;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inInput(e) || (e.key !== "[" && e.key !== "]")) return;
      e.preventDefault();
      setRange(stepRange(cur.current, e.key === "]" ? 1 : -1));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const pts = (h.data?.range === range ? h.data.points : null)?.map((x) => ({ ts: x.ts, p: x.mid }))
    ?? (h.error || !conditionId ? fallback.flatMap((x) => (x.mid == null ? [] : [{ ts: x.ts, p: x.mid }])) : null);
  const series = withLive(pts ?? [], liveMid, Date.now());
  const d = change(series);
  const levels = ownOrders.map((o) => ({ key: o.orderId, p: o.price, outcome, label: `your ${o.side === "BUY" ? "bid" : "ask"} ${outcome} ${(o.price * 100).toFixed(1)}¢ · ${sh(o.shares - o.filled)}` }));
  return (
    <div className={css.chartBox}>
      <div className={css.ctools}>
        <span className={css.cleg}><i className={css.swY} />YES <i className={css.swN} />NO</span>
        {d != null && <span className={`${css.n} ${d >= 0 ? css.up : css.down}`} title={`YES change over ${SPAN[range]}`}>{d >= 0 ? "+" : "−"}{Math.abs(d * 100).toFixed(1)}¢ <span className={css.dim}>{SPAN[range]}</span></span>}
        {h.data?.source === "snapshots" && <span className={css.dim}>own snapshots</span>}
        <span className={css.sp} />
        <Seg label="Outcomes shown" options={SHOW_OPTS} value={show} onChange={setShow} />
        <Seg label="Range" options={RANGE_OPTS} value={range} onChange={setRange} />
        <span className={css.dim}><kbd>[</kbd><kbd>]</kbd></span>
      </div>
      <div className={css.chart}>
        {pts == null ? <p className={`${css.line} ${css.msg}`}>Loading history…</p>
          : <OutcomeChart points={pts} live={liveMid} show={show} levels={levels} empty="No price history in this range." className={css.ochart} />}
      </div>
    </div>
  );
}

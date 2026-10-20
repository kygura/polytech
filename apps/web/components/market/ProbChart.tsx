"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { chordKey, inInput } from "../../hooks/useGlobalKeys";
import { DEFAULT_RANGE, RANGES, type HistoryResult } from "../../lib/history";
import {
  ariaSummary, axisFor, cents, cleanPoints, extent, lineStats, linear, mergeLive, nearestIndex, orderLabel, stepRange, tagLayout,
  timeLabel, valueAt, xDomain, xTicks, yesPrice, yLabelClear, type AxisMode, type HistPt, type Outcome, type OwnOrder, type Range,
} from "./probChart";
import css from "./probChart.module.css";

export type ChartMarker = { ts: number; pHat: number; side: Outcome };
export type ChartOrder = OwnOrder;
export type ProbChartProps = {
  conditionId: string;
  /** feed.mid ?? snapshot.mid, YES space 0..1; appended as the last point at now. */
  liveMid?: number | null;
  /** Latest thesis estimate, YES space 0..1: dashed line. */
  pHat?: number | null;
  /** Thesis entries: triangle on the YES line at `ts`, filled by `side`. Filtered to the visible range. */
  markers?: readonly ChartMarker[];
  /** Own open orders; `price` is in the order's own outcome, `shares` is the open size. */
  ownOrders?: readonly ChartOrder[];
  /** The ticket's outcome: its line cannot be hidden and its price tag wins an overlap. */
  outcome?: Outcome;
  /** Market tick (0.01 -> `6¢`, 0.001 -> `6.2¢`). */
  tick?: number;
  /** Controlled range (e.g. from `?range=`); omit for internal state starting at 1M. */
  range?: Range;
  onRangeChange?: (r: Range) => void;
  /** `[` `]` step the range and `f` toggles Fit while no input or dialog has focus. Turn off when the page owns those keys. */
  keys?: boolean;
};

const PAD = { t: 8, r: 52, b: 22 };
const RANGE_OPTS = RANGES.map((r) => ({ value: r, label: r.toUpperCase() }));
const AXIS_OPTS = [{ value: "full" as const, label: "0–100" }, { value: "fit" as const, label: "Fit" }];
const AXIS_KEY = "pm.chart.axis";
const EMPTY: Record<Range, string> = { "1d": "No points in the last day", "1w": "No points in the last week", "1m": "No points in the last month", all: "No price history yet." };
const TTL = 60_000;

// Module memo: one entry per market + range, same 60 s the route caches for. Only resolved responses are kept.
const memo = new Map<string, { at: number; res: HistoryResult }>();
const remember = (key: string, res: HistoryResult) => {
  if (memo.size >= 100) memo.delete(memo.keys().next().value!);
  memo.set(key, { at: Date.now(), res });
};

type Loaded = { id: string; key: string; res: HistoryResult };

/** Per-range history: abort on change, memoised per id + range. Keeps the last good result while the next one loads or fails. */
function useHistory(id: string, range: Range) {
  const key = `${id}|${range}`;
  const [last, setLast] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const hit = memo.get(key);
    if (hit) {
      setLast({ id, key, res: hit.res });
      setFailed(null);
      if (Date.now() - hit.at < TTL) return;
    }
    const ac = new AbortController();
    fetch(`/api/markets/${encodeURIComponent(id)}/history?range=${range}`, { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<HistoryResult>; })
      .then((j) => {
        const res: HistoryResult = { range, source: j.source === "polymarket" ? "polymarket" : "snapshots", points: cleanPoints(j.points) };
        remember(key, res);
        setLast({ id, key, res });
        setFailed(null);
      })
      .catch(() => { if (!ac.signal.aborted) setFailed(key); });
    return () => ac.abort();
  }, [id, range, key, tries]);
  const shown = last?.id === id ? last : null; // another market's lines are never shown
  return { res: shown?.res ?? null, loading: shown?.key !== key && failed !== key, stale: shown != null && shown.key !== key, failed: failed === key, retry: () => { setFailed(null); setTries((n) => n + 1); } };
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

/** Latest `v`, applied at most every `ms` (the aria-live tooltip text). */
function useThrottled<T>(v: T, ms: number): T {
  const [out, setOut] = useState(v);
  const latest = useRef(v), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = v;
  useEffect(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; setOut(latest.current); }, ms);
  }, [v, ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return out;
}

/** Radiogroup of text buttons: arrows move and select, only the selected one is in the tab order. */
function Seg<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = Math.min(options.length - 1, Math.max(0, options.findIndex((o) => o.value === value) + d)), group = e.currentTarget;
    onChange(options[n]!.value);
    requestAnimationFrame(() => group.querySelectorAll("button")[n]?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} className={css.seg} onKeyDown={key}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

const path = (pts: readonly HistPt[], x: (t: number) => number, y: (p: number) => number, flip: boolean) =>
  pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y((flip ? 1 - p.mid : p.mid) * 100).toFixed(1)}`).join("");

/** DESIGN 13.4 PriceChart: YES and NO (= 1 − YES) probability lines over a range of history, hand-rolled SVG. Fills its container (min 220px). */
export function ProbChart({ conditionId, liveMid = null, pHat = null, markers = [], ownOrders = [], outcome, tick = 0.01, range: rangeProp, onRangeChange, keys = true }: ProbChartProps) {
  const [rangeState, setRangeState] = useState<Range>(DEFAULT_RANGE);
  const range = rangeProp ?? rangeState;
  const setRange = useCallback((r: Range) => { setRangeState(r); onRangeChange?.(r); }, [onRangeChange]);
  const [axisMode, setAxisMode] = useState<AxisMode>("full");
  const [hide, setHide] = useState({ YES: false, NO: false });
  const [hover, setHover] = useState<{ i: number; py: number } | null>(null);
  const [wrap, { w: W, h: H }] = useSize<HTMLDivElement>();
  const h = useHistory(conditionId, range);

  useEffect(() => { try { if (localStorage.getItem(AXIS_KEY) === "fit") setAxisMode("fit"); } catch { /* storage is optional */ } }, []);
  const pickAxis = useCallback((m: AxisMode) => { setAxisMode(m); try { localStorage.setItem(AXIS_KEY, m); } catch { /* ignore */ } }, []);

  const cur = useRef({ range, axisMode });
  cur.current = { range, axisMode };
  useEffect(() => {
    if (!keys) return;
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inInput(e) || chordKey(e) || document.querySelector("dialog[open]")) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const n = stepRange(cur.current.range, e.key === "]" ? 1 : -1);
        if (n !== cur.current.range) setRange(n);
      } else if (e.key === "f") {
        e.preventDefault();
        pickAxis(cur.current.axisMode === "fit" ? "full" : "fit");
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [keys, setRange, pickAxis]);

  // The ticket's outcome line is always shown; hiding one line un-hides the other, so never both.
  const hidden = { YES: hide.YES && outcome !== "YES", NO: hide.NO && outcome !== "NO" };
  const toggle = (o: Outcome) => setHide((s) => ({ YES: o === "YES" ? !s.YES : false, NO: o === "NO" ? !s.NO : false }));

  const hist = h.res?.points;
  const pts = useMemo(() => mergeLive(hist ?? [], liveMid, Date.now()), [hist, liveMid]);
  const [d0, d1] = xDomain(pts, range);
  const vis = useMemo(() => pts.filter((p) => p.ts >= d0), [pts, d0]);
  const tip = hover ? vis[hover.i] : null;
  const live = useThrottled(tip ? `${timeLabel(tip.ts, range, d1 - d0)}, YES ${cents(tip.mid, tick)}, NO ${cents(1 - tip.mid, tick)}` : "", 250);

  const plotW = W - PAD.r, plotH = H - PAD.t - PAD.b;
  const ready = W > 0 && plotW > 40 && plotH > 40;
  const lastYes = vis.at(-1)?.mid ?? null;
  const summary = ariaSummary(range, lastYes, vis.length, tick);
  const head = (
    <div className={css.bar}>
      <div className={css.legend}>
        {(["YES", "NO"] as const).map((o) => (
          <button key={o} type="button" className={`${css.chip} ${o === "YES" ? css.yes : css.no}`} aria-pressed={!hidden[o]} disabled={outcome === o}
            title={outcome === o ? "The ticket's outcome stays visible" : `${hidden[o] ? "Show" : "Hide"} the ${o} line`} onClick={() => toggle(o)}>
            <span className={css.dot} aria-hidden="true" />{o}{lastYes != null && <span className={css.n}> {cents(o === "YES" ? lastYes : 1 - lastYes, tick)}</span>}
          </button>
        ))}
      </div>
      <div className={css.ctl}>
        {h.failed && <button type="button" className={css.err} onClick={h.retry} role="alert">history unavailable · retry</button>}
        {h.res && !h.failed && <span className={css.src}>{h.res.source}</span>}
        <Seg label="Chart range" options={RANGE_OPTS} value={range} onChange={setRange} />
        <Seg label="Chart axis" options={AXIS_OPTS} value={axisMode} onChange={pickAxis} />
      </div>
    </div>
  );

  let body: ReactNode = null;
  if (ready && vis.length >= 2) {
    const showYes = !hidden.YES, showNo = !hidden.NO;
    const orders = ownOrders.filter((o) => Number.isFinite(o.price));
    const hat = pHat != null && Number.isFinite(pHat) ? pHat : null;
    const extras = [...(hat == null ? [] : [hat * 100]), ...orders.map((o) => yesPrice(o) * 100)];
    const ax = axisFor(axisMode, extent(vis, showYes, showNo, extras), showYes && showNo);
    const x = linear(d0, d1, 0, plotW), y = linear(ax.hi, ax.lo, PAD.t, PAD.t + plotH);
    const xt = xTicks(d0, d1, range, plotW);
    const clampY = (v: number) => Math.min(H - 9, Math.max(9, v));
    const last = vis.at(-1)!, lx = x(last.ts);
    const yYes = y(last.mid * 100), yNo = y((1 - last.mid) * 100);
    const tags = tagLayout(showYes ? yYes : null, showNo ? yNo : null, outcome ?? "YES");
    const tagYs = [tags.yes ? clampY(yYes) : null, tags.no ? clampY(yNo) : null];
    const ctx = outcome ?? "YES";
    const dim = h.loading && h.stale;
    const hv = hover && vis[hover.i] ? vis[hover.i]! : null;
    const move = (e: PointerEvent<SVGSVGElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (px < 0 || px > plotW) return;
      setHover({ i: nearestIndex(vis, d0 + (px / plotW) * (d1 - d0)), py: e.clientY - r.top });
    };
    const inView = markers.filter((m) => m.ts >= d0 && m.ts <= d1 && Number.isFinite(m.pHat));
    body = (
      <>
        <svg className={css.svg} width={W} height={H} role="img" aria-label={summary} onPointerMove={move} onPointerDown={move}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}>
          {ax.ticks.map((v) => (
            <g key={v}>
              <line className={css.grid} x1={0} x2={plotW} y1={y(v)} y2={y(v)} />
              {yLabelClear(y(v), tagYs) && <text className={css.ylab} x={plotW + 8} y={y(v) + 4}>{v}%</text>}
            </g>
          ))}
          {xt.map((t) => <text key={t.ts} className={css.xlab} x={t.x} y={H - 6} textAnchor="middle">{t.label}</text>)}

          <g opacity={dim ? 0.4 : 1}>
            {showYes && <path className={css.lineYes} d={path(vis, x, y, false)} vectorEffect="non-scaling-stroke" />}
            {showNo && <path className={css.lineNo} d={path(vis, x, y, true)} vectorEffect="non-scaling-stroke" />}
          </g>

          {hat != null && (
            <g className={css.focus}>
              <line className={css.dash} x1={0} x2={plotW} y1={y(hat * 100)} y2={y(hat * 100)} vectorEffect="non-scaling-stroke" />
              <text className={css.olab} x={4} y={y(hat * 100) - 4}>p̂ {cents(hat, tick)}</text>
            </g>
          )}
          {orders.map((o, i) => {
            const oy = y(yesPrice(o) * 100);
            return (
              <g key={i} className={css.focus}>
                <line className={css.dash} x1={0} x2={plotW} y1={oy} y2={oy} vectorEffect="non-scaling-stroke" />
                <text className={css.olab} x={plotW - 6} y={oy - 4} textAnchor="end">{orderLabel(o, tick, ctx)}</text>
              </g>
            );
          })}
          {inView.map((m, i) => {
            const mx = x(m.ts), my = y((valueAt(vis, m.ts) ?? 0) * 100);
            return (
              <path key={i} className={m.side === "YES" ? css.mkYes : css.mkNo} d={`M${mx},${my - 4}L${mx + 3.5},${my + 2}L${mx - 3.5},${my + 2}Z`}>
                <title>{`${m.side} thesis, p̂ ${cents(m.pHat, tick)}, ${timeLabel(m.ts, range, d1 - d0)}`}</title>
              </path>
            );
          })}

          {liveMid != null && (
            <>
              {showYes && <><circle className={`${css.ring} ${css.ringYes}`} cx={lx} cy={yYes} r={3} /><circle className={css.liveYes} cx={lx} cy={yYes} r={3} /></>}
              {showNo && <><circle className={`${css.ring} ${css.ringNo}`} cx={lx} cy={yNo} r={3} /><circle className={css.liveNo} cx={lx} cy={yNo} r={3} /></>}
            </>
          )}
          {tags.yes && <g><rect className={css.tagYes} x={plotW + 4} y={clampY(yYes) - 9} width={44} height={18} rx={4} /><text className={css.tagTxtYes} x={plotW + 26} y={clampY(yYes) + 4} textAnchor="middle">{cents(last.mid, tick)}</text></g>}
          {tags.no && <g><rect className={css.tagNo} x={plotW + 4} y={clampY(yNo) - 9} width={44} height={18} rx={4} /><text className={css.tagTxtNo} x={plotW + 26} y={clampY(yNo) + 4} textAnchor="middle">{cents(1 - last.mid, tick)}</text></g>}

          {hv && (
            <g pointerEvents="none">
              <line className={css.cross} x1={x(hv.ts)} x2={x(hv.ts)} y1={PAD.t} y2={PAD.t + plotH} />
              {showYes && <circle className={css.dotYes} cx={x(hv.ts)} cy={y(hv.mid * 100)} r={4} />}
              {showNo && <circle className={css.dotNo} cx={x(hv.ts)} cy={y((1 - hv.mid) * 100)} r={4} />}
            </g>
          )}
        </svg>
        {hv && hover && (
          <div className={css.tip} style={{ left: x(hv.ts) + (plotW - x(hv.ts) < 150 ? -12 : 12), top: Math.min(Math.max(0, hover.py - 12), Math.max(0, H - 76)), transform: plotW - x(hv.ts) < 150 ? "translateX(-100%)" : undefined }} aria-hidden="true">
            <div>{timeLabel(hv.ts, range, d1 - d0)}</div>
            {showYes && <div className={css.tipYes}>YES {cents(hv.mid, tick)}</div>}
            {showNo && <div className={css.tipNo}>NO {cents(1 - hv.mid, tick)}</div>}
            {hat != null && <div className={css.tipHat}>p̂ {cents(hat, tick)}</div>}
          </div>
        )}
      </>
    );
  } else if (ready) {
    body = h.loading && !h.res ? (
      <div className={css.skel} aria-hidden="true"><i style={{ top: "25%" }} /><i style={{ top: "50%" }} /><i style={{ top: "75%" }} /></div>
    ) : (
      <div className={css.empty}>
        <p>{EMPTY[range]}</p>
        {range !== "all" && vis.length < 2 && <button type="button" onClick={() => setRange("all")}>Show ALL</button>}
      </div>
    );
  }

  const stats = lineStats(vis);
  return (
    <div className={css.root} aria-busy={h.loading}>
      {head}
      <div ref={wrap} className={css.body}>
        {body}
        <div className={css.sr} aria-live="polite">{live}</div>
        {stats && (
          <table className={css.sr}>
            <caption>{summary}</caption>
            <thead><tr><th>Line</th><th>First</th><th>Last</th><th>Min</th><th>Max</th></tr></thead>
            <tbody>
              {(["YES", "NO"] as const).map((o) => (
                <tr key={o}><th>{o}</th>{(["first", "last", "min", "max"] as const).map((k) => <td key={k}>{cents(stats[o][k], tick)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

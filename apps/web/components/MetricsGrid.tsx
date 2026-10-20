import type { ReactNode } from "react";
import type { Detail } from "./detail";
import { ago, fmt } from "./fmt";
import { SRC, usdShort } from "./screener/columns";
import css from "./detail.module.css";

type Latest = NonNullable<Detail["latest"]>;
type Mkt = Pick<Detail["market"], "feeRate" | "liquidity" | "vol24h" | "resolutionSource">;

const dash = <span className="muted">{"—"}</span>;
const usd = (v: number | null | undefined, signed = false): ReactNode =>
  v == null ? dash : <span className={signed ? (v > 0 ? "pos" : v < 0 ? "neg" : "muted") : undefined} title={fmt(v, "usd", signed)}>{signed && v > 0 ? "+$" : v < 0 ? "−$" : "$"}{usdShort(Math.abs(v))}</span>;
const num = (v: number | null | undefined, f: Parameters<typeof fmt>[1]): ReactNode => (v == null ? dash : fmt(v, f));

/** DESIGN 12.6.4: market_latest plus the market row, as a 4-column `<dl>`. Values are shown as stored; null = `—`. */
export function MetricsGrid({ latest: l, market: m, oi, now }: { latest: Latest | null; market: Mkt; oi: number | null; now: number }) {
  const hours = l?.lastTradeTs == null ? null : Math.max(0, (now - l.lastTradeTs) / 3_600_000);
  const rows: [string, ReactNode][] = [
    ["mid", num(l?.mid, "p")], ["bid", num(l?.bestBid, "p")], ["ask", num(l?.bestAsk, "p")], ["spread (¢)", l?.spread == null ? dash : fmt(l.spread * 100, "cents")],
    ["fee", m.feeRate == null ? dash : `${(m.feeRate * 100).toFixed(1)}%`], ["liq", usd(m.liquidity)], ["vol24h", usd(m.vol24h)], ["OI", usd(oi)],
    ["d±1¢", usd(l?.depth1c)], ["d±2¢", usd(l?.depth2c)], ["d±5¢", usd(l?.depth5c)], ["exit depth", usd(l?.exitDepth)],
    ["capacity (@1¢)", usd(l?.capacity)], ["holders", num(l?.holderCount, "int")], ["HHI", l?.holderHhi == null ? dash : l.holderHhi.toFixed(2)], ["top1", num(l?.top1Share, "pct")],
    ["top5", num(l?.top5Share, "pct")], ["flow 24h", usd(l?.flow24h, true)], ["median ticket", usd(l?.tradeMedian)], ["large trade 24h", l?.largeTrade24h == null ? dash : l.largeTrade24h ? "yes" : dash],
    ["last trade", l?.lastTradeTs == null ? dash : ago(now - l.lastTradeTs)], ["stale (h)", hours == null ? dash : Math.round(hours)], ["priority", l?.priority == null ? dash : l.priority.toFixed(2)],
    ["src", m.resolutionSource ? <span title={m.resolutionSource}>{SRC[m.resolutionSource] ?? m.resolutionSource}</span> : dash],
  ];
  return (
    <dl className={css.metrics} aria-label="market metrics">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

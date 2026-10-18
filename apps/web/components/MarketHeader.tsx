import { Sparkline } from "./Sparkline";
import type { Detail } from "./detail";
import { fmt, mmdd } from "./fmt";
import css from "./detail.module.css";

// Narrow slices so the public /trade detail (lib/public.ts projection) renders the same header.
type Snap = Pick<NonNullable<Detail["snapshot"]>, "ts" | "mid" | "bestBid" | "bestAsk" | "depth5cUsd" | "vol24h" | "oi" | "top10Share"> | null;
type Hist = Pick<Detail["history"][number], "ts" | "mid">[];
type Mkt = Pick<Detail["market"], "conditionId" | "question" | "category" | "endDate" | "daysLeft" | "feeRate" | "status">;

const usdK = (v: number | null) => (v == null ? "—" : v >= 1000 ? `$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : `$${fmt(v, "usd")}`);

export function KeyStats({ snapshot, history }: { snapshot: Snap; history: Hist }) {
  const s = snapshot;
  const last = history[history.length - 1]?.ts ?? 0;
  const day = history.filter((h) => h.ts >= last - 86_400_000 && h.mid != null).map((h) => h.mid as number);
  return (
    <div className={css.stats} aria-label="key stats">
      <span><b>mid</b>{fmt(s?.mid, "p")}</span>
      <span><b>bid</b>{fmt(s?.bestBid, "p")}</span>
      <span><b>ask</b>{fmt(s?.bestAsk, "p")}</span>
      <span><b>depth5¢</b>${fmt(s?.depth5cUsd, "usd")}</span>
      <span><b>vol24h</b>{usdK(s?.vol24h ?? null)}</span>
      <span><b>OI</b>{usdK(s?.oi ?? null)}</span>
      <span><b>top10</b>{s?.top10Share == null ? "—" : `${Math.round(s.top10Share * 100)}%`}</span>
      <Sparkline points={day} label={`24h mid, ${day.length} points`} />
    </div>
  );
}

export function MarketHeader({ market: m, snapshot, history, now }: { market: Mkt; snapshot: Snap; history: Hist; now: number }) {
  return (
    <header className={`pane ${css.head}`}>
      <h1 className={css.q}>{m.question}</h1>
      <div className={css.meta}>
        {m.category && <span>{m.category}</span>}
        <span>ends {m.endDate ? mmdd(m.endDate) : "—"}</span>
        <span>{Math.max(0, Math.round(m.daysLeft))}d left</span>
        <span>fee {m.feeRate == null ? "—" : `${(m.feeRate * 100).toFixed(1)}%`}</span>
        <span>{m.status}</span>
        <a href={`https://polymarket.com/market/${m.conditionId}`} target="_blank" rel="noreferrer">Open on Polymarket {"↗"}</a>
        <span title={new Date(now).toISOString()}>{snapshot ? `snapshot ${mmdd(snapshot.ts)}` : "no snapshot"}</span>
      </div>
      <KeyStats snapshot={snapshot} history={history} />
    </header>
  );
}

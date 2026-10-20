import { Sparkline } from "./Sparkline";
import type { Detail } from "./detail";
import { fmt, mmdd } from "./fmt";
import { Badge, STALE_TRADE_H } from "./screener/columns";
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

/** DESIGN 12.6.1 badge inputs: market_latest.structural / opportunity.contrarian / last_trade_ts, plus the screen's structural detail for the tooltip. Operator page only. */
export type HeaderFlags = {
  structural: readonly string[] | null; contrarian: boolean; lastTradeTs: number | null;
  detail?: { type: string; lockedC: number; sum: number | null } | null;
};

/** Tooltip for one structural kind: the numbers when the screen kept them, else the kind. */
export function structuralReason(kind: string, d?: HeaderFlags["detail"]): string {
  switch (kind) {
    case "overround": return d?.type === "neg-risk-sum" ? `overround +${d.lockedC.toFixed(1)}\u00a2 net of fees` : "overround net of fees";
    case "monotonicity_violation": return d?.type === "ladder" ? `ladder: monotonicity violated, +${d.lockedC.toFixed(1)}\u00a2 net` : "ladder: monotonicity violated";
    case "sibling_inconsistency": return d?.sum != null ? `sibling sum ${d.sum.toFixed(2)}` : "sibling sum inconsistent";
    default: return kind;
  }
}

/** `S` per structural kind, then `C` contrarian, then `Z` no trade for 48 h (same Badge and order as the screener). */
export function HeaderBadges({ flags: f, now }: { flags: HeaderFlags; now: number }) {
  const h = f.lastTradeTs == null ? null : (now - f.lastTradeTs) / 3_600_000;
  return (
    <>
      {(f.structural ?? []).map((k) => <Badge key={k} letter="S" color="var(--badge-s, #a58bf5)" title={structuralReason(k, f.detail)} />)}
      {f.contrarian && <Badge letter="C" color="var(--badge-c, #d97bb0)" title="contrarian" />}
      {h != null && h > STALE_TRADE_H && <Badge letter="Z" color="var(--warn)" title={`no trade for ${Math.round(h / 24)}d`} />}
    </>
  );
}

export function MarketHeader({ market: m, snapshot, history, now, flags }: { market: Mkt; snapshot: Snap; history: Hist; now: number; flags?: HeaderFlags }) {
  return (
    <header className={`pane ${css.head}`}>
      <h1 className={css.q}>{m.question}</h1>
      <div className={css.meta}>
        {m.category && <span>{m.category}</span>}
        <span>ends {m.endDate ? mmdd(m.endDate) : "—"}</span>
        <span>{Math.max(0, Math.round(m.daysLeft))}d left</span>
        <span>fee {m.feeRate == null ? "—" : `${(m.feeRate * 100).toFixed(1)}%`}</span>
        <span>{m.status}</span>
        {flags && <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }}><HeaderBadges flags={flags} now={now} /></span>}
        <a href={`https://polymarket.com/market/${m.conditionId}`} target="_blank" rel="noreferrer">Open on Polymarket {"↗"}</a>
        <span title={new Date(now).toISOString()}>{snapshot ? `snapshot ${mmdd(snapshot.ts)}` : "no snapshot"}</span>
      </div>
      <KeyStats snapshot={snapshot} history={history} />
    </header>
  );
}

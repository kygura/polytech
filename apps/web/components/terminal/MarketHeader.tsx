import type { ReactNode } from "react";
import type { MarketFeed } from "../../hooks/useMarketFeed";
import { Badge, OutcomeCard } from "../ui";
import { cents, sh, usdShort, type Outcome } from "./book";
import { DEFAULT_TICK } from "./ticket";
import css from "./terminal.module.css";

export const STALE_TRADE_H = 48; // `Z` badge threshold
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export type HeaderMeta = { conditionId: string; question: string; category: string | null; endDate: number | null; daysLeft: number; feeRate?: number | null };
/** market_latest.structural / opportunity.contrarian / last_trade_ts, plus the screen's structural detail for the tooltip. */
export type HeaderFlags = {
  structural: readonly string[] | null; contrarian: boolean; lastTradeTs: number | null;
  detail?: { type: string; lockedC: number; sum: number | null } | null;
};

/** Tooltip for one structural kind: the numbers when the screen kept them, else the kind. */
export function structuralReason(kind: string, d?: HeaderFlags["detail"]): string {
  switch (kind) {
    case "overround": return d?.type === "neg-risk-sum" ? `overround +${d.lockedC.toFixed(1)}¢ net of fees` : "overround net of fees";
    case "monotonicity_violation": return d?.type === "ladder" ? `ladder: monotonicity violated, +${d.lockedC.toFixed(1)}¢ net` : "ladder: monotonicity violated";
    case "sibling_inconsistency": return d?.sum != null ? `sibling sum ${d.sum.toFixed(2)}` : "sibling sum inconsistent";
    default: return kind;
  }
}

/** `S` per structural kind, then `C` contrarian, then `Z` no trade for 48 h. */
export function HeaderBadges({ flags: f, now }: { flags: HeaderFlags; now: number }) {
  const h = f.lastTradeTs == null ? null : (now - f.lastTradeTs) / 3_600_000;
  return (
    <>
      {(f.structural ?? []).map((k) => <Badge key={k} kind="s" reason={structuralReason(k, f.detail)} />)}
      {f.contrarian && <Badge kind="c" reason="contrarian" />}
      {h != null && h > STALE_TRADE_H && <span className={css.zBadge} title={`no trade for ${Math.round(h / 24)}d`} aria-label={`no trade for ${Math.round(h / 24)}d`}>Z</span>}
    </>
  );
}

/**
 * Question (wraps in full), meta line, the two outcome cards (mouse form of Y / N) and the action toolbar (DESIGN 13.4 MarketHeader).
 * `yes` = the YES display price (mid, or last trade when the book is wider than 10¢); NO = 1 − YES.
 */
export function MarketHeader({ meta, tick, yes, outcome, onOutcome, notFound, flags, now, actions, pro }: {
  meta: HeaderMeta | null; tick: number | null; yes: number | null; outcome: Outcome; onOutcome: (o: Outcome) => void; notFound: boolean;
  flags: HeaderFlags | null; now: number; actions: ReactNode;
  /** Pro view: price step and fee in the meta line. */
  pro: boolean;
}) {
  return (
    <header className={css.hero}>
      <div className={css.heroL}>
        <h1>{meta?.question ?? (notFound ? "This market is not on the public list." : "Loading market…")}</h1>
        {meta && (
          <div className={css.meta}>
            {meta.category && <span className={css.catChip}>{meta.category}</span>}
            <span>ends {meta.endDate ? day(meta.endDate) : "—"} {"·"} {Math.max(0, Math.round(meta.daysLeft))}d</span>
            {pro && <span className={css.n} title="Prices move in steps of this size">tick {tick == null ? "—" : `${cents(tick, tick)}¢`}</span>}
            {pro && meta.feeRate != null && <span className={css.n} title="Taker fee rate, charged when an order fills against the book">fee {(meta.feeRate * 100).toFixed(1)}%</span>}
            {flags && <HeaderBadges flags={flags} now={now} />}
            <a href={`https://polymarket.com/market/${meta.conditionId}`} target="_blank" rel="noreferrer">Polymarket {"↗"}</a>
          </div>
        )}
      </div>
      <div className={css.out}>
        <OutcomeCard outcome="YES" price={yes} pressed={outcome === "YES"} kbd="Y" onClick={() => onOutcome("YES")} title="YES price now: a YES share pays $1 if the market resolves YES. Click to trade YES (y)" />
        <OutcomeCard outcome="NO" price={yes == null ? null : 1 - yes} pressed={outcome === "NO"} kbd="N" onClick={() => onOutcome("NO")} title="NO price now: a NO share pays $1 if the market resolves NO. Click to trade NO (n)" />
      </div>
      <div className={css.heroAct}>{actions}</div>
    </header>
  );
}

/** `book` is the chosen outcome's (mirrored for NO). */
export function KeyStats({ book, vol24h, oi, depth5c }: { book: MarketFeed | null; vol24h: number | null; oi: number | null; depth5c: number | null }) {
  const t = book?.tickSize ?? DEFAULT_TICK, bid = book?.bids[0]?.price ?? null, ask = book?.asks[0]?.price ?? null;
  const cell = (label: string, v: string, cls = "") => <div><span className={css.lbl}>{label}</span><span className={`${css.n} ${cls}`}>{v}</span></div>;
  const c = (p: number | null) => (p == null ? "—" : `${cents(p, t)}¢`);
  return (
    <div className={css.stats}>
      {cell("Last", c(book?.last ?? null))}
      {cell("Bid", c(bid), css.up)}
      {cell("Ask", c(ask), css.down)}
      {cell("Spread", bid == null || ask == null ? "—" : `${cents(ask - bid, t)}¢`)}
      {cell("Min order", book?.minOrderSize == null ? "—" : `${sh(book.minOrderSize)} sh`)}
      {cell("Vol 24h", vol24h == null ? "—" : usdShort(vol24h))}
      {cell("OI", oi == null ? "—" : usdShort(oi))}
      {cell("Depth 5¢", depth5c == null ? "—" : usdShort(depth5c))}
    </div>
  );
}

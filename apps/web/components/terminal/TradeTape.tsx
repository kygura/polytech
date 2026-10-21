"use client";
import { useRef } from "react";
import type { FeedStatus, MarketFeed } from "../../hooks/useMarketFeed";
import { hms } from "../fmt";
import { DEFAULT_TICK } from "./ticket";
import { PaneSkeleton } from "./PaneSkeleton";
import { cents, sh, tradeKey } from "./book";
import css from "./terminal.module.css";

/** feed.trades newest first, ≤ 50. New rows (vs the previous payload of the same market) get the tint; side null → dim. */
export function TradeTape({ feed, status, viewKey }: { feed: MarketFeed | null; status: FeedStatus; viewKey: string }) {
  const prev = useRef<{ view: string; at: number; keys: Set<string>; fresh: Set<string> } | null>(null);
  let fresh = new Set<string>();
  if (feed) {
    const p = prev.current?.view === viewKey ? prev.current : null;
    const keys = new Set(feed.trades.map(tradeKey));
    if (p && p.at === feed.at) fresh = p.fresh;
    else {
      if (p) fresh = new Set([...keys].filter((k) => !p.keys.has(k)));
      prev.current = { view: viewKey, at: feed.at, keys, fresh };
    }
  }
  const tick = feed?.tickSize ?? DEFAULT_TICK;
  return (
    <section className={`${css.pane} ${css.tape}`} aria-label="trades">
      <h2 className={css.ph}>Trades <span className={css.r}>{status === "stale" && <span className={`${css.badge} ${css.stale}`}><i aria-hidden />stale</span>}≥ $1k bold</span></h2>
      <div className={css.scroll}>
        {!feed ? (status === "error" ? <p className={`${css.line} ${css.neg} ${css.msg}`}>Feed error · retrying</p>
          : <PaneSkeleton />)
          : !feed.trades.length ? <p className={`${css.line} ${css.msg}`}>No trades yet.</p>
          : (
            <table aria-label="recent trades, newest first">
              <tbody>
                {feed.trades.slice(0, 50).map((t, i) => {
                  const k = tradeKey(t);
                  return (
                    <tr key={`${k}#${i}`} className={`${fresh.has(k) ? css.tint : ""} ${i >= 20 ? css.far : ""}`} style={t.size * t.price >= 1000 ? { fontWeight: 600 } : undefined}>
                      <td className={css.dim}>{hms(t.ts * 1000)}</td>
                      <td className={t.side === "BUY" ? css.up : t.side === "SELL" ? css.down : css.dim}>{cents(t.price, tick)}</td>
                      <td>{sh(t.size)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}

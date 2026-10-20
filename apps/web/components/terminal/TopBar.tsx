"use client";
import Link from "next/link";
import { useEffect, useState, type RefObject } from "react";
import type { FeedStatus } from "../../hooks/useMarketFeed";
import { hms } from "../fmt";
import { ConnectButton } from "../public/PublicShell";
import css from "./terminal.module.css";

/** Text plus dot or spinner, never a dot alone (DESIGN 11.7). `at` = feed.at (server ms). */
export function FeedBadge({ status, at, now }: { status: FeedStatus; at: number | null; now: number }) {
  const body = status === "loading" ? <><span className={css.spin} aria-hidden />connecting feed…</>
    : status === "live" ? <><i aria-hidden />live · {at == null ? "—" : hms(at)}</>
    : status === "stale" ? <><i aria-hidden />stale · {at == null ? "—" : `${Math.max(0, Math.round((now - at) / 1000))}s old`}</>
    : <><i aria-hidden />feed error · retrying</>;
  return <span role="status" className={`${css.badge} ${css[status]}`}>{body}</span>;
}

type Props = {
  feedStatus: FeedStatus; feedAt: number | null; now: number; balance: number | null;
  query: string; onQuery: (q: string) => void; onSearchFocus: () => void; onSearchKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** An order is mid-send: the logo link must not navigate; `onBlocked` explains why. */
  locked: boolean; onBlocked: () => void;
};

/** DESIGN 12.1.4: `GET /api/session` once on mount; the `← Operator` link renders only for an operator session. Any failure = anonymous. */
function useOperator() {
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/session").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j?.operator === true) setOperator(true); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return operator;
}

export function TopBar({ feedStatus, feedAt, now, balance, query, onQuery, onSearchFocus, onSearchKey, searchRef, locked, onBlocked }: Props) {
  const operator = useOperator();
  return (
    <header className={`${css.pane} ${css.top}`}>
      <Link href="/trade" className={css.logo} onClick={(e) => { if (locked) { e.preventDefault(); onBlocked(); } }}>PM<i>/</i>EDGE <span className={css.dim} style={{ fontWeight: 400 }}>terminal</span></Link>
      {operator && <Link href="/markets" className={css.opLink} onClick={(e) => { if (locked) { e.preventDefault(); onBlocked(); } }}>{"← Operator"}</Link>}
      <label className={css.search}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" /></svg>
        <input ref={searchRef} data-filter type="search" placeholder="Search markets" aria-label="Search markets" value={query}
          onChange={(e) => onQuery(e.target.value)} onFocus={onSearchFocus} onKeyDown={onSearchKey} />
        <kbd>/</kbd>
      </label>
      <span className={css.sp}><FeedBadge status={feedStatus} at={feedAt} now={now} /></span>
      <ConnectButton />
      {balance != null && <span className={`${css.pill} ${css.n}`}><span className={css.dim}>USDC</span> {balance.toFixed(2)}</span>}
    </header>
  );
}

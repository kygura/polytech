import type { FeedSource, FeedStatus } from "../../hooks/useMarketFeed";
import { hms } from "../fmt";
import css from "./terminal.module.css";

/** Text plus dot or spinner, never a dot alone (DESIGN 11.7). `at` = feed.at (server ms). Lives in the status bar on /trade. */
export function FeedBadge({ status, at, now, source = "poll" }: { status: FeedStatus; at: number | null; now: number; source?: FeedSource }) {
  const body = status === "loading" ? <><span className={css.spin} aria-hidden />connecting feed…</>
    : status === "live" ? <><i aria-hidden />live · {source} · {at == null ? "—" : hms(at)}</>
    : status === "stale" ? <><i aria-hidden />stale · {at == null ? "—" : `${Math.max(0, Math.round((now - at) / 1000))}s old`}</>
    : <><i aria-hidden />feed error · retrying</>;
  return <span role="status" className={`${css.badge} ${css[status]}`}>{body}</span>;
}

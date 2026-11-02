import { read } from "../../../lib/jobs";
import { WatchlistView, type Tab } from "./WatchlistView";

const TABS = new Set<Tab>(["small-cap", "size", "structural", "alerts"]);

export default async function WatchlistPage({ searchParams }: { searchParams: Promise<{ tab?: string; muted?: string }> }) {
  const q = await searchParams;
  const tab: Tab = TABS.has(q.tab as Tab) ? (q.tab as Tab) : "small-cap";
  const showMuted = q.muted === "1";
  const r = await read.readDeps();
  const o = { includeMuted: showMuted };
  const [small, size, structural, snap] = await Promise.all([
    read.watchlist(r, "small-cap", "rank", o),
    read.watchlist(r, "size", "rank", o),
    read.watchlist(r, "structural", "rank", o),
    r.db.snapshots.first("byTs", {}, { order: "desc" }).then((x) => x?.ts.getTime() ?? null),
  ]);
  return <WatchlistView tab={tab} small={small} size={size} structural={structural} showMuted={showMuted} lastSnapshotAt={snap} now={r.now()} />;
}

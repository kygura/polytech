import { schema as s } from "@pm/db";
import { desc } from "drizzle-orm";
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
    r.db.select({ ts: s.snapshots.ts }).from(s.snapshots).orderBy(desc(s.snapshots.ts)).limit(1).then((x) => x[0]?.ts.getTime() ?? null),
  ]);
  return <WatchlistView tab={tab} small={small} size={size} structural={structural} showMuted={showMuted} lastSnapshotAt={snap} now={r.now()} />;
}

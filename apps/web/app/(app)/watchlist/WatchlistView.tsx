"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DataTable, MarketCell, type Column, type Sort } from "../../../components/DataTable";
import { EdgeBadge } from "../../../components/EdgeBadge";
import { EmptyState } from "../../../components/EmptyState";
import { FilterInput } from "../../../components/FilterInput";
import { NumCell } from "../../../components/NumCell";
import { ResearchRunning } from "../../../components/ResearchRunning";
import { STALE_MS, StaleBanner } from "../../../components/StaleBanner";
import { Tabs } from "../../../components/Tabs";
import { hms, truncate } from "../../../components/fmt";
import { inInput } from "../../../hooks/useGlobalKeys";
import type { StructuralRow, WatchlistRow } from "../../../lib/jobs/read";
import css from "./watchlist.module.css";

export type Tab = "small-cap" | "size" | "structural";
type Props = { tab: Tab; small: WatchlistRow[]; size: WatchlistRow[]; structural: StructuralRow[]; showMuted: boolean; lastSnapshotAt: number | null; now: number };

const Pin = ({ pinned }: { pinned: boolean }) => (pinned ? <span className={css.pin} title="pinned" aria-label="pinned">{"●"}</span> : null);
const Side = ({ side }: { side: "YES" | "NO" | null }) => (side ? <span className={side === "YES" ? "pos" : "neg"}>{side}</span> : <span className="muted">{"—"}</span>);

type WRow = WatchlistRow & { n: number }; // n = 1-based position in server rank order; rank itself is a score
const WATCH_COLS: Column<WRow>[] = [
  { id: "rank", header: "#", align: "r", sortable: true, cell: (r) => <><Pin pinned={r.pinned} />{r.rank != null ? r.n : <span className="muted" title={`priority ${r.priority?.toFixed(2) ?? "—"}`}>{r.priority?.toFixed(2) ?? "—"}</span>}</> },
  { id: "market", header: "Market", align: "l", cell: (r) => <MarketCell question={r.question} category={r.category} /> },
  { id: "side", header: "Side", align: "l", cell: (r) => <Side side={r.side} /> },
  { id: "pMid", header: "p_mid", align: "r", cell: (r) => <NumCell value={r.pMid} fmt="p" /> },
  { id: "pHat", header: "p̂", align: "r", cell: (r) => r.researching ? <ResearchRunning /> : <NumCell value={r.pHat} fmt="p" muted={(r.thesisAgeH ?? 0) > 72} title={(r.thesisAgeH ?? 0) > 72 ? `thesis ${Math.round(r.thesisAgeH!)}h old` : undefined} /> },
  { id: "pPost", header: "p_post", align: "r", cell: (r) => <NumCell value={r.pPost} fmt="p" /> },
  { id: "edge", header: "Edge¢", align: "r", sortable: true, cell: (r) => <EdgeBadge cents={r.edgeC} /> },
  { id: "size", header: "Size$", align: "r", sortable: true, cell: (r) => <NumCell value={r.sizeUsd} fmt="usd" /> },
  { id: "ep", header: "E[P]$", align: "r", sortable: true, cell: (r) => <NumCell value={r.expectedProfit} fmt="usd" signed /> },
  { id: "r_ann", header: "r_ann", align: "r", sortable: true, cell: (r) => <NumCell value={r.rAnn} fmt="pct" /> },
  { id: "payoff", header: "Payoff", align: "r", cell: (r) => <NumCell value={r.payoff} fmt="x" /> },
  { id: "days", header: "Days", align: "r", sortable: true, cell: (r) => <NumCell value={r.daysLeft} fmt="int" /> },
  { id: "catalyst", header: "Catalyst", align: "l", cell: (r) => r.nextCatalyst ? <span title={r.nextCatalyst}>{truncate(r.nextCatalyst.slice(5), 24)}</span> : <span className="muted">{"—"}</span> },
  { id: "c", header: "c", align: "r", cell: (r) => r.c == null ? <span className="muted">{"—"}</span> : <span className={r.capped ? "warn" : undefined} title={r.capped ? "disagreement cap tripped" : undefined}>{r.c.toFixed(2)}{r.capped ? "*" : ""}</span> },
];
const WATCH_KEY: Record<string, (r: WRow) => number | null> = {
  rank: (r) => r.n, edge: (r) => r.edgeC, size: (r) => r.sizeUsd, ep: (r) => r.expectedProfit, r_ann: (r) => r.rAnn, days: (r) => r.daysLeft,
};

const STRUCT_COLS: Column<StructuralRow & { n: number }>[] = [
  { id: "rank", header: "#", align: "r", sortable: true, cell: (r) => <><Pin pinned={r.pinned} />{r.n}</> },
  { id: "market", header: "Market", align: "l", cell: (r) => <MarketCell question={r.question} category={r.category} /> },
  { id: "type", header: "Type", align: "l", cell: (r) => r.type },
  { id: "kind", header: "Kind", align: "l", cell: (r) => r.kind ?? <span className="muted">{"—"}</span> },
  { id: "legs", header: "Legs", align: "r", cell: (r) => r.legs },
  { id: "sum", header: "Σ", align: "r", title: "sum of best asks (buy-all) or bids (sell-all)", cell: (r) => <NumCell value={r.sum} fmt="p" /> },
  { id: "edge", header: "Locked¢", align: "r", sortable: true, cell: (r) => <EdgeBadge cents={r.lockedC} /> },
  { id: "size", header: "Size$", align: "r", sortable: true, cell: (r) => <NumCell value={r.sizeUsd} fmt="usd" /> },
  { id: "days", header: "Days", align: "r", sortable: true, cell: (r) => <NumCell value={r.daysLeft} fmt="int" /> },
];
const STRUCT_KEY: Record<string, (r: StructuralRow & { n: number }) => number | null> = { rank: (r) => r.n, edge: (r) => r.lockedC, size: (r) => r.sizeUsd, days: (r) => r.daysLeft };

function sortBy<T>(rows: T[], key: ((r: T) => number | null) | undefined, dir: "asc" | "desc") {
  if (!key) return rows;
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => ((key(a) ?? Infinity) - (key(b) ?? Infinity)) * m);
}
const matches = (q: string) => (r: { question: string; category: string | null }) => !q || `${r.question} ${r.category ?? ""}`.toLowerCase().includes(q);

export function WatchlistView({ tab, small, size, structural, showMuted, lastSnapshotAt, now }: Props) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ id: "rank", dir: "asc" });
  const [selected, setSelected] = useState<string | null>(null);
  const stale = lastSnapshotAt == null || now - lastSnapshotAt > STALE_MS;
  const q = filter.trim().toLowerCase();

  const go = (t: Tab, m = showMuted) => router.push(`/watchlist?tab=${t}${m ? "&muted=1" : ""}`);
  const open = (id: string) => router.push(`/markets/${id}`);

  const watchRows = useMemo(() => sortBy((tab === "size" ? size : small).map((r, i) => ({ ...r, n: i + 1 })).filter(matches(q)), WATCH_KEY[sort.id], sort.dir), [tab, small, size, q, sort]);
  const structRows = useMemo(() => sortBy(structural.map((r, i) => ({ ...r, n: i + 1 })).filter(matches(q)), STRUCT_KEY[sort.id], sort.dir), [structural, q, sort]);
  const rows: { conditionId: string; pinned: boolean; muted: boolean }[] = tab === "structural" ? structRows : watchRows;

  // p / m / r act on the selected row.
  useEffect(() => {
    const h = async (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey || !selected) return;
      const row = rows.find((r) => r.conditionId === selected);
      if (!row) return;
      if (e.key === "p" || e.key === "m") {
        const body = e.key === "p" ? { pinned: !row.pinned } : { muted: !row.muted };
        await fetch(`/api/markets/${row.conditionId}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        router.refresh();
      } else if (e.key === "r") {
        await fetch(`/api/markets/${row.conditionId}/research`, { method: "POST" });
        router.refresh();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [rows, selected, router]);

  const table = tab === "structural" ? (
    structRows.length ? (
      <DataTable columns={STRUCT_COLS} rows={structRows} rowKey={(r) => r.conditionId} sort={sort} onSort={setSort} selectedKey={selected} onSelect={setSelected} onOpen={(r) => open(r.conditionId)} muted={stale} label="structural edges" />
    ) : <EmptyState text={q ? "No rows match the filter." : "No structural edges in the last sweep."} />
  ) : watchRows.length ? (
    <DataTable columns={WATCH_COLS} rows={watchRows} rowKey={(r) => r.conditionId} sort={sort} onSort={setSort} selectedKey={selected} onSelect={setSelected} onOpen={(r) => open(r.conditionId)} muted={stale} label={`${tab} watchlist`} />
  ) : <EmptyState text={q ? "No rows match the filter." : "No theses yet."} />;

  return (
    <>
      <div className={css.bar}>
        <Tabs active={tab} onChange={(t) => go(t as Tab)} items={[
          { id: "small-cap", label: "Small-cap", count: small.length }, { id: "size", label: "Size", count: size.length }, { id: "structural", label: "Structural", count: structural.length },
        ]} />
        <div className={css.right}>
          <label className={css.check}><input type="checkbox" checked={showMuted} onChange={(e) => go(tab, e.target.checked)} /> show muted</label>
          <FilterInput value={filter} onChange={setFilter} placeholder="filter question / category" />
          <span className="muted">{lastSnapshotAt ? `swept ${hms(lastSnapshotAt)}` : "never swept"}</span>
        </div>
      </div>
      {stale && <StaleBanner lastSnapshotAt={lastSnapshotAt} now={now} />}
      {table}
    </>
  );
}

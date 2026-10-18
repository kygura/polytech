"use client";
// /trade watchlist (DESIGN 10.2): polled public thesis list of both tiers, client-side filter and sort, cards under 720px.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { usePoll } from "../../hooks/usePoll";
import type { PublicWatchlist as Data, PublicWatchRow as Row } from "../../lib/public";
import { DataTable, MarketCell, type Column, type Sort } from "../DataTable";
import { EdgeBadge } from "../EdgeBadge";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { FilterInput } from "../FilterInput";
import { NumCell } from "../NumCell";
import { ResearchRunning } from "../ResearchRunning";
import { Skeleton } from "../Skeleton";
import { fmt, hm } from "../fmt";
import ui from "../ui.module.css";
import css from "./public.module.css";

const POLL_MS = 60_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ends = (r: Row) => `${r.endDate ? `${MON[new Date(r.endDate).getMonth()]} ${String(new Date(r.endDate).getDate()).padStart(2, "0")} · ` : ""}${Math.max(0, Math.round(r.daysLeft))}d`;
const ageTxt = (h: number) => (h < 24 ? `${Math.max(0, Math.round(h))}h` : `${Math.round(h / 24)}d`);
const price = (r: Row) => r.pMid ?? r.midNow;
const dash = <span className="muted">{"—"}</span>;

const Side = ({ side }: { side: Row["side"] }) => (side ? <span className={side === "YES" ? "pos" : "neg"}>{side}</span> : dash);
const Conf = ({ r }: { r: Row }) => (r.c == null ? dash : <span className={r.capped ? "warn" : undefined} title={r.capped ? "disagreement cap tripped" : undefined}>{r.c.toFixed(2)}{r.capped ? "*" : ""}</span>);

const COLS: Column<Row>[] = [
  { id: "market", header: "Market", align: "l", sortable: true, cell: (r) => <MarketCell question={r.question} category={r.category} /> },
  { id: "side", header: "Side", align: "l", sortable: true, cell: (r) => <Side side={r.side} /> },
  { id: "price", header: "Price", align: "r", sortable: true, cell: (r) => <NumCell value={price(r)} fmt="p" /> },
  { id: "fair", header: "Fair p", align: "r", sortable: true, cell: (r) => (r.research === "researching" ? <ResearchRunning /> : <NumCell value={r.pPost} fmt="p" />) },
  { id: "edge", header: "Edge¢", align: "r", sortable: true, cell: (r) => <EdgeBadge cents={r.edgeC} /> },
  { id: "conf", header: "Conf", align: "r", sortable: true, cell: (r) => <Conf r={r} /> },
  { id: "ends", header: "Ends", align: "r", sortable: true, cell: (r) => ends(r) },
  { id: "thesis", header: "Thesis", align: "r", sortable: true, cell: (r) => (r.thesisAgeH == null ? dash : r.thesisAgeH > 72 ? <span className="muted" title={`thesis ${Math.round(r.thesisAgeH)}h old`}>{ageTxt(r.thesisAgeH)}</span> : ageTxt(r.thesisAgeH)) },
];
const KEY: Record<string, (r: Row) => number | string | null> = {
  market: (r) => r.question.toLowerCase(), side: (r) => r.side, price, fair: (r) => r.pPost, edge: (r) => r.edgeC, conf: (r) => r.c, ends: (r) => r.daysLeft, thesis: (r) => r.thesisAgeH,
};
const SORT_LABEL: Record<string, string> = { edge: "Edge", price: "Price", fair: "Fair p", conf: "Conf", ends: "Ends", thesis: "Thesis age", market: "Market", side: "Side" };

/** Nulls last in both directions. */
function sortRows(rows: Row[], s: Sort) {
  const k = KEY[s.id];
  if (!k) return rows;
  const m = s.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = k(a), y = k(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * m;
  });
}

/** Ticks once a second for the `refresh in 42s` line. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export function PublicWatchlist() {
  const router = useRouter();
  const poll = usePoll<Data>("/api/public/watchlist", POLL_MS);
  const now = useNow();
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("");
  const [side, setSide] = useState("");
  const [sort, setSort] = useState<Sort>({ id: "edge", dir: "desc" });
  const [selected, setSelected] = useState<string | null>(null);

  const d = poll.data;
  const all = d?.rows ?? [];
  const categories = useMemo(() => [...new Set(all.map((r) => r.category).filter((c): c is string => !!c))].sort(), [all]);
  const q = filter.trim().toLowerCase();
  const rows = useMemo(
    () => sortRows(all.filter((r) => (!q || `${r.question} ${r.category ?? ""}`.toLowerCase().includes(q)) && (!category || r.category === category) && (!side || r.side === side)), sort),
    [all, q, category, side, sort],
  );
  const open = (id: string) => router.push(`/trade/${id}`);
  const narrowed = !!(q || category || side);

  const sweptAt = d?.snapshotAt ?? null;
  // kick:sweepAt newer than the last snapshot = this read (or a recent one) started the scouting chain.
  const refreshing = d?.sweptAt != null && (sweptAt == null || d.sweptAt > sweptAt);
  const nextIn = poll.nextAt ? Math.max(0, Math.round((poll.nextAt - now) / 1000)) : null;

  let body;
  if (!d) body = poll.error ? null : <Skeleton rows={8} />;
  else if (!all.length) body = <EmptyState text={d.research === "disabled" ? "Research is paused on this instance. Market data still updates." : "No theses yet. Markets are scanned daily; the first research run is in progress."} />;
  else if (!rows.length) body = <EmptyState text="No rows match the filter." action={narrowed ? <button type="button" onClick={() => { setFilter(""); setCategory(""); setSide(""); }}>Clear filters</button> : undefined} />;
  else body = (
    <>
      <div className={css.tableWrap}>
        <DataTable columns={COLS} rows={rows} rowKey={(r) => r.conditionId} sort={sort} onSort={setSort} selectedKey={selected} onSelect={setSelected} onOpen={(r) => open(r.conditionId)} muted={d.stale} label="public watchlist" />
      </div>
      <ul className={css.cards} aria-label="public watchlist">
        {rows.map((r) => (
          <li key={r.conditionId}>
            <Link href={`/trade/${r.conditionId}`}>
              <span className={css.clamp}>{r.question}</span>
              <span className="muted">
                {r.side ?? "—"} {"·"} {fmt(price(r), "p")} {"→"} {fmt(r.pPost, "p")} {"·"} {r.edgeC == null ? "—" : `${fmt(r.edgeC, "cents", true)}¢`} {"·"} c {r.c == null ? "—" : r.c.toFixed(2)} {"·"} {Math.max(0, Math.round(r.daysLeft))}d
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <>
      <div className={css.bar}>
        <FilterInput value={filter} onChange={setFilter} placeholder="filter question / category" />
        <select aria-label="category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="side" value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="">Any</option><option value="YES">YES</option><option value="NO">NO</option>
        </select>
        <select aria-label="sort" className={css.sortSel} value={sort.id} onChange={(e) => setSort({ id: e.target.value, dir: e.target.value === "ends" || e.target.value === "thesis" || e.target.value === "market" ? "asc" : "desc" })}>
          {Object.entries(SORT_LABEL).map(([id, l]) => <option key={id} value={id}>Sort: {l}</option>)}
        </select>
        <span className={`muted ${css.barRight}`}>
          {d && (sweptAt ? `swept ${hm(sweptAt)}` : "never swept")}
          {refreshing && <span className={ui.status}><span className={ui.spinner} aria-hidden /> refreshing data…</span>}
          {nextIn != null && <span>{"·"} refresh in {nextIn}s</span>}
        </span>
      </div>
      {poll.error && <ErrorBar message={poll.status === 429 ? "Too many requests. Retrying in 60 s." : "Could not load the watchlist. Retrying in 60 s."} onRetry={poll.refresh} />}
      {d?.stale && (
        <div className={`${ui.bar} ${ui.barWarn}`} role="status">
          <span className="warn">Data may be out of date {"·"} {sweptAt ? `last sweep ${hm(sweptAt)} (${Math.round((now - sweptAt) / 3_600_000)} h)` : "no sweep yet"}</span>
        </div>
      )}
      {body}
    </>
  );
}

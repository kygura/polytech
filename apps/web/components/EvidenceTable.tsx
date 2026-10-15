"use client";
import { useMemo, useState } from "react";
import { DataTable, type Column, type Sort } from "./DataTable";
import { EmptyState } from "./EmptyState";
import type { Detail } from "./detail";
import { host, mmdd, words } from "./fmt";
import css from "./detail.module.css";

type Ev = Detail["evidence"][number];
const COLS: Column<Ev>[] = [
  { id: "dir", header: "Dir", align: "l", sortable: true, cell: (e) => e.direction > 0 ? <span className="pos" aria-label="supports">+</span> : e.direction < 0 ? <span className="neg" aria-label="against">{"−"}</span> : <span className="muted">0</span> },
  { id: "role", header: "Role", align: "l", sortable: true, cell: (e) => e.role },
  { id: "claim", header: "Claim", align: "l", cell: (e) => <span className={css.claim}>{e.claim}</span> },
  { id: "quote", header: "Quote", align: "l", cell: (e) => <span className={css.quote} title={e.quote ?? undefined}>{e.quote ? words(e.quote, 25) : "—"}</span> },
  { id: "pub", header: "Published", align: "l", sortable: true, cell: (e) => e.publishedAt ? mmdd(e.publishedAt) : <span className="muted">{"—"}</span> },
  { id: "ret", header: "Retrieved", align: "l", cell: (e) => mmdd(e.retrievedAt) },
  { id: "url", header: "URL", align: "l", cell: (e) => <a href={e.url} target="_blank" rel="noreferrer" title={e.url}>{host(e.url)}</a> },
];
const KEY: Record<string, (e: Ev) => number | string> = { dir: (e) => -e.direction, role: (e) => e.role, pub: (e) => e.publishedAt ?? 0 };

export function EvidenceTable({ evidence }: { evidence: Ev[] }) {
  const [sort, setSort] = useState<Sort>({ id: "dir", dir: "asc" });
  const rows = useMemo(() => {
    const k = KEY[sort.id];
    if (!k) return evidence;
    const m = sort.dir === "asc" ? 1 : -1;
    return [...evidence].sort((a, b) => (k(a) < k(b) ? -m : k(a) > k(b) ? m : 0));
  }, [evidence, sort]);
  if (!evidence.length) return <EmptyState text="No evidence yet" />;
  return <DataTable columns={COLS} rows={rows} rowKey={(e) => String(e.id)} sort={sort} onSort={setSort} keys={false} label="evidence" />;
}

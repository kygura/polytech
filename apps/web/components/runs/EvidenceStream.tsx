"use client";
import { DataTable, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { Flat } from "../pageParts";
import { Panel } from "../ui";
import { host, mmdd, words } from "../fmt";
import detail from "../detail.module.css";

export type Ev = { id: number; role: string; claim: string; quote: string | null; url: string | null; direction: number; publishedAt: number | null; retrievedAt: number };

const COLS: Column<Ev>[] = [
  { id: "role", header: "Role", align: "l", cell: (e) => e.role },
  { id: "dir", header: "Dir", align: "l", cell: (e) => e.direction > 0 ? <span className="up" aria-label="supports">+</span> : e.direction < 0 ? <span className="down" aria-label="against">{"−"}</span> : <span className="muted">0</span> },
  { id: "claim", header: "Claim", align: "l", cell: (e) => <span className={detail.claim}>{e.claim}</span> },
  { id: "quote", header: "Quote", align: "l", cell: (e) => <span className={detail.quote} title={e.quote ?? undefined}>{e.quote ? words(e.quote, 25) : "—"}</span> },
  { id: "pub", header: "Published", align: "l", cell: (e) => e.publishedAt ? mmdd(e.publishedAt) : <span className="muted">{"—"}</span> },
  { id: "ret", header: "Retrieved", align: "l", cell: (e) => mmdd(e.retrievedAt) },
  { id: "url", header: "URL", align: "l", cell: (e) => (e.url ? <a href={e.url} target="_blank" rel="noreferrer" title={e.url}>{host(e.url)}</a> : <span className="muted">{"—"}</span>) },
];

/** All evidence rows of the pod, newest first (EvidenceTable columns, Role leading). */
export function EvidenceStream({ evidence }: { evidence: Ev[] }) {
  const rows = [...evidence].sort((a, b) => b.retrievedAt - a.retrievedAt || b.id - a.id);
  return (
    <Panel title={`Evidence (${evidence.length})`}>
      {rows.length ? <Flat><DataTable columns={COLS} rows={rows} rowKey={(e) => String(e.id)} keys={false} label="evidence" /></Flat> : <EmptyState text="No evidence yet" />}
    </Panel>
  );
}

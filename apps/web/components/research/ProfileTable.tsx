import { DataTable, type Column } from "../DataTable";
import { hm } from "../fmt";
import type { Profile } from "./steering";
import cx from "../../app/(app)/research/research.module.css";

export const NEW_ID = "new";
const every = (m: number | null) => (m == null ? "—" : m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);

/** Profile list. `On` is a switch that PUTs immediately; disabled for the dirty selected profile. */
export function ProfileTable({ profiles, selected, onSelect, onToggle, lockedId, matchCounts, onOpen }: {
  profiles: Profile[]; selected: string | null; onSelect: (id: string) => void; onToggle: (p: Profile) => void; lockedId: string | null; matchCounts: Record<string, number>; onOpen: () => void;
}) {
  const cols: Column<Profile>[] = [
    { id: "name", header: "Name", align: "l", cell: (p) => <span className={p.id === NEW_ID ? "muted" : undefined} title={p.name} style={{ display: "inline-block", maxWidth: "28ch", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>{p.name}</span> },
    { id: "on", header: "On", align: "l", cell: (p) => p.id === NEW_ID ? null : (
      <button type="button" role="switch" aria-checked={p.enabled} aria-label={`${p.name} enabled`} className={cx.sw} disabled={lockedId === p.id}
        title={lockedId === p.id ? "Save or discard changes first" : p.enabled ? "enabled" : "disabled"}
        onClick={(e) => { e.stopPropagation(); onToggle(p); }}>
        <span className={p.enabled ? "pos" : "muted"}>{p.enabled ? "●" : "○"}</span>
      </button>
    ) },
    { id: "every", header: "Every", align: "r", cell: (p) => every(p.everyMin) },
    { id: "last", header: "Last run", align: "r", cell: (p) => p.lastRunAt == null ? <span className="muted">{"—"}</span> : hm(p.lastRunAt) },
    { id: "match", header: "Match", align: "r", cell: (p) => matchCounts[p.id] == null ? <span className="muted">{"—"}</span> : matchCounts[p.id] },
  ];
  return <DataTable columns={cols} rows={profiles} rowKey={(p) => p.id} selectedKey={selected} onSelect={onSelect} onOpen={onOpen} label="research profiles" />;
}

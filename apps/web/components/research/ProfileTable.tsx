import { DataTable, type Column } from "../DataTable";
import { hm } from "../fmt";
import type { Profile } from "./steering";
import cx from "../../app/(app)/research/research.module.css";

export const NEW_ID = "new";
const every = (m: number | null) => (m == null ? "manual" : m % 1440 === 0 ? `every ${m / 1440}d` : m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`);
const row2 = () => "row2";

/** Profile list (240px rail). `On` is a switch that PUTs immediately; disabled for the dirty selected profile. Schedule and last run sit under the name. */
export function ProfileTable({ profiles, selected, onSelect, onToggle, lockedId, matchCounts, onOpen }: {
  profiles: Profile[]; selected: string | null; onSelect: (id: string) => void; onToggle: (p: Profile) => void; lockedId: string | null; matchCounts: Record<string, number>; onOpen: () => void;
}) {
  const cols: Column<Profile>[] = [
    { id: "name", header: "Name", align: "l", cell: (p) => (
      <span className={cx.pname} title={p.name}>
        <span className={`q ${p.id === NEW_ID ? "muted" : ""}`}>{p.name}</span>
        {p.id !== NEW_ID && <span className={`${cx.psub} n`}>{every(p.everyMin)}{p.lastRunAt != null && ` · ran ${hm(p.lastRunAt)}`}</span>}
      </span>
    ) },
    { id: "on", header: "On", align: "l", cell: (p) => p.id === NEW_ID ? null : (
      <button type="button" role="switch" aria-checked={p.enabled} aria-label={`${p.name} enabled`} className={cx.sw} disabled={lockedId === p.id}
        title={lockedId === p.id ? "Save or discard changes first" : p.enabled ? "enabled" : "disabled"}
        onClick={(e) => { e.stopPropagation(); onToggle(p); }}>
        <span className={p.enabled ? "up" : "muted"}>{p.enabled ? "●" : "○"}</span>
      </button>
    ) },
    { id: "match", header: "Match", align: "r", title: "markets matched by the last preview", cell: (p) => matchCounts[p.id] == null ? <span className="muted">{"—"}</span> : matchCounts[p.id] },
  ];
  return <DataTable columns={cols} rows={profiles} rowKey={(p) => p.id} selectedKey={selected} onSelect={onSelect} onOpen={onOpen} label="research profiles" rowClass={row2} />;
}

import type { Mode } from "@pm/core";
import { ModeBadge } from "./ModeBadge";
import { hms, mmdd } from "./fmt";
import { Panel, Table } from "./ui";

export type AutonomyEvent = { id: number; ts: number; fromMode: Mode; toMode: Mode; scope: string; reason: string; actor: string };

/** Newest first (API order). Refused requests (EXECUTION_DISABLED) are marked in --warn with text, not color only. */
export function EventLog({ events }: { events: AutonomyEvent[] }) {
  return (
    <Panel title="Events" right={<span className="n">{events.length}</span>}>
      <Table label="autonomy events">
        <thead><tr><th scope="col">ts</th><th scope="col">from → to</th><th scope="col">scope</th><th scope="col">reason</th><th scope="col">actor</th></tr></thead>
        <tbody>
          {events.length ? events.map((e) => {
            const refused = e.reason.includes("EXECUTION_DISABLED");
            return (
              <tr key={e.id}>
                <td className="n">{mmdd(e.ts)} {hms(e.ts)}</td>
                <td><ModeBadge mode={e.fromMode} /> {"→"} <ModeBadge mode={e.toMode} /></td>
                <td>{e.scope}</td>
                <td className={refused ? "warn" : undefined}>{refused ? "REFUSED · " : ""}{e.reason}</td>
                <td className="muted">{e.actor}</td>
              </tr>
            );
          }) : <tr><td colSpan={5} className="muted">No events yet</td></tr>}
        </tbody>
      </Table>
    </Panel>
  );
}

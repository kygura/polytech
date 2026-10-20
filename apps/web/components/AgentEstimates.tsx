import type { Detail } from "./detail";
import { dur } from "./fmt";
import { Panel } from "./ui";

export function AgentEstimates({ agents }: { agents: Detail["agents"] }) {
  return (
    <Panel title="Agent estimates">
      <table aria-label="agent estimates">
        <thead><tr><th scope="col">Role</th><th scope="col" className="num">p</th><th scope="col" className="num">conf</th><th scope="col">Model</th><th scope="col" className="num">Duration</th></tr></thead>
        <tbody>
          {agents.length ? agents.map((a, i) => (
            <tr key={i}>
              <td className="ui">{a.role}{a.status !== "ok" && a.status !== "done" && <span className="down"> {a.status}</span>}</td>
              <td className="num">{a.role === "rules" || a.probability == null ? <span className="muted">{"—"}</span> : a.probability.toFixed(3)}</td>
              <td className="num">{a.confidence == null ? <span className="muted">{"—"}</span> : a.confidence.toFixed(2)}</td>
              <td className="muted n">{a.model}</td>
              <td className="num">{a.durationS == null ? "—" : dur(a.durationS)}</td>
            </tr>
          )) : <tr><td colSpan={5} className="muted ui">No agent runs</td></tr>}
        </tbody>
      </table>
    </Panel>
  );
}

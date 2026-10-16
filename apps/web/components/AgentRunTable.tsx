import { StatusDot } from "./StatusDot";
import { dur } from "./fmt";
import { dotStatus, type Pod } from "./PodTable";

const num = (v: unknown, d: number) => (typeof v === "number" ? v.toFixed(d) : <span className="muted">{"—"}</span>);

export type AgentRun = Pod["agents"][number];

export function AgentRunTable({ agents, onView }: { agents: AgentRun[]; onView: (a: AgentRun) => void }) {
  return (
    <table aria-label="agent runs">
      <thead>
        <tr><th scope="col">Role</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" className="num">p</th><th scope="col" className="num">conf</th><th scope="col" className="num">Duration</th><th scope="col" className="num">Tokens in/out</th><th scope="col">Output</th></tr>
      </thead>
      <tbody>
        {agents.length ? agents.map((a, i) => {
          const o = (a.output ?? {}) as { probability?: unknown; p_hat?: unknown; confidence?: unknown };
          return (
            <tr key={i}>
              <td>{a.role}</td>
              <td className="muted">{a.model}</td>
              <td><StatusDot status={dotStatus(a.status)} label={a.status} /></td>
              <td className="num">{a.role === "rules" ? <span className="muted">{"—"}</span> : num(o.probability ?? o.p_hat, 3)}</td>
              <td className="num">{num(o.confidence, 2)}</td>
              <td className="num">{a.durationS == null ? <span className="muted">{"—"}</span> : dur(a.durationS)}</td>
              <td className="num">{a.usage.inputTokens.toLocaleString("en-US")} / {a.usage.outputTokens.toLocaleString("en-US")}</td>
              <td>
                {a.output == null ? <span className="muted">{"—"}</span> : (
                  <button type="button" onClick={(e) => { e.stopPropagation(); onView(a); }}>view output</button>
                )}
              </td>
            </tr>
          );
        }) : <tr><td colSpan={8} className="muted">No agent runs yet</td></tr>}
      </tbody>
    </table>
  );
}

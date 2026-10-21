"use client";
import { DataTable, type Column } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { Flat } from "../pageParts";
import { Panel } from "../ui";
import { StatusDot } from "../StatusDot";
import { dotStatus } from "../PodTable";
import { dur, hms } from "../fmt";
import { ToolCallLog, type ToolCall } from "./ToolCallLog";
import { agentDurS, agentP, byRole, retryIds, usd2 } from "./runs";
import css from "./runs.module.css";

export type Agent = {
  id: number; role: string; model: string; status: string; output: unknown;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  durationS: number | null; startedAt: number | null; finishedAt: number | null; toolCalls: ToolCall[];
};

const dash = <span className="muted">{"—"}</span>;

export function AgentTable({ agents, now, selected, onSelect, onView }: { agents: Agent[]; now: number; selected: string | null; onSelect: (id: string) => void; onView: (a: Agent) => void }) {
  if (!agents.length) return <Panel title="Agents"><EmptyState text="No agent runs yet" /></Panel>;
  const retries = retryIds(agents);
  const cols: Column<Agent>[] = [
    { id: "role", header: "Role", align: "l", cell: (a) => <span className="n">{a.role}</span> },
    { id: "model", header: "Model", align: "l", cell: (a) => <span className="muted">{a.model}</span> },
    { id: "status", header: "Status", align: "l", cell: (a) => <StatusDot status={dotStatus(a.status)} label={a.status} /> },
    { id: "started", header: "Started", align: "r", cell: (a) => a.startedAt == null ? dash : <span suppressHydrationWarning>{hms(a.startedAt)}</span> },
    { id: "dur", header: "Dur", align: "r", cell: (a) => { const d = agentDurS(a, now); return d == null ? dash : dur(d); } },
    { id: "tok", header: "Tokens in/out", align: "r", cell: (a) => a.usage ? `${a.usage.inputTokens.toLocaleString("en-US")} / ${a.usage.outputTokens.toLocaleString("en-US")}` : dash },
    { id: "cost", header: "Cost", align: "r", cell: (a) => a.usage ? usd2(a.usage.costUsd) : dash },
    { id: "tools", header: "Tools", align: "r", cell: (a) => a.toolCalls.length },
    { id: "p", header: "p", align: "r", cell: (a) => { const p = agentP(a.output); return a.role === "rules" || p == null ? dash : p.toFixed(3); } },
    { id: "retry", header: "retry", align: "l", cell: (a) => retries.has(a.id) ? <span className={css.tag}>retry</span> : null },
  ];
  return (
    <Panel title="Agents" right={<span className="n">{agents.length}</span>}><Flat><DataTable columns={cols} rows={byRole(agents)} rowKey={(a) => String(a.id)} selectedKey={selected} onSelect={onSelect} label="agent runs"
      rowClass={(a) => (a.status === "running" ? css.live : undefined)}
      renderExpanded={(a) => (
        <div className={css.xbody}>
          <ToolCallLog calls={a.toolCalls} />
          {a.output != null && <button type="button" className={css.link} onClick={() => onView(a)}>view output</button>}
        </div>
      )} /></Flat></Panel>
  );
}

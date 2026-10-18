"use client";
import { BUILTIN_ROLES } from "@pm/core";
import { DataTable, MarketCell, type Column } from "./DataTable";
import { StatusDot, type DotStatus } from "./StatusDot";
import { dur, hm } from "./fmt";
import type { read } from "../lib/jobs";
import type { ReactNode } from "react";
import css from "./panels.module.css";

export type Fleet = Awaited<ReturnType<typeof read.fleet>>;
export type Pod = Fleet["pods"][number];

export const ROLES = ["rules", "source", "base_rate", "news", "red_team", "judge"];
/** One dot per agent the pod actually has: built-ins in order, then custom roles, judge last. Before any agent row exists, the default set. */
export const podRoles = (p: Pod) => {
  const have = p.agents.map((a) => a.role);
  if (!have.length) return ROLES;
  return [...ROLES.filter((r) => r !== "judge" && have.includes(r)), ...have.filter((r) => !ROLES.includes(r)), ...(have.includes("judge") ? ["judge"] : [])];
};
/** profile name, else ad-hoc (steered, no profile), else screener. */
export const podSource = (p: Pod) => p.profileId || p.trigger === "profile" ? { label: p.profileName ?? "deleted profile", muted: p.profileName == null } : p.steered ? { label: "ad-hoc", muted: true } : { label: "screener", muted: true };
/** Deviations from default steering as one mono line ("" when none). */
export const steeringLine = (st: Pod["steering"]) => {
  if (!st) return "";
  const out: string[] = [];
  if (st.roles && st.roles.length < BUILTIN_ROLES.length) out.push(`roles ${st.roles.join(",")}`);
  if (st.customRoles?.length) out.push(`+${st.customRoles.length} custom`);
  const m = Object.entries(st.models ?? {}).map(([r, v]) => `${r} ${v}`);
  if (m.length) out.push(m.join(", "));
  if (st.maxCostUsd != null) out.push(`cap $${st.maxCostUsd}`);
  return out.join(" · ");
};
export const dotStatus = (s: string): DotStatus => (s === "ok" || s === "done" ? "done" : s === "failed" ? "failed" : s === "running" || s === "judging" ? s : "queued");
export const podTokens = (p: Pod) => p.agents.reduce((t, a) => t + a.usage.inputTokens + a.usage.outputTokens, 0);
const live = (s: string) => s === "running" || s === "judging" || s === "queued";
/** Running pods: wall clock. Finished: longest agent (pods store no finishedAt). */
const elapsed = (p: Pod, now: number) => (live(p.status) ? (now - p.startedAt) / 1000 : Math.max(0, ...p.agents.map((a) => a.durationS ?? 0)));

const cols = (now: number): Column<Pod>[] => [
  { id: "pod", header: "Pod", align: "l", cell: (p) => <span title={p.id}>{p.id.slice(0, 8)}</span> },
  { id: "market", header: "Market", align: "l", cell: (p) => p.question ? <MarketCell question={p.question} category={null} max={40} /> : <span className="muted">{p.conditionId.slice(0, 10)}</span> },
  { id: "source", header: "Source", align: "l", cell: (p) => { const s = podSource(p); return (
    <span className="ui" title={s.label}><span className={s.muted ? "muted" : undefined} style={{ display: "inline-block", maxWidth: "18ch", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>{s.label}</span>
      {p.steeringQuestion && <span style={{ color: "var(--accent)" }} title={p.steeringQuestion.slice(0, 120)} aria-label={`question: ${p.steeringQuestion.slice(0, 120)}`}> ?</span>}</span>
  ); } },
  { id: "trigger", header: "Trigger", align: "l", cell: (p) => p.trigger },
  { id: "started", header: "Started", align: "r", cell: (p) => hm(p.startedAt) },
  { id: "elapsed", header: "Elapsed", align: "r", cell: (p) => <span title={live(p.status) ? undefined : "longest agent"}>{dur(elapsed(p, now))}</span> },
  { id: "status", header: "Status", align: "l", cell: (p) => <StatusDot status={dotStatus(p.status)} label={p.status} /> },
  { id: "agents", header: "Agents", align: "l", cell: (p) => (
    <span className={css.dots}>
      {podRoles(p).map((role) => { const a = p.agents.find((x) => x.role === role); return <span key={role} title={`${role}: ${a?.status ?? "queued"}`}><StatusDot status={a ? dotStatus(a.status) : "queued"} label={false} /></span>; })}
    </span>
  ) },
  { id: "tokens", header: "Tokens", align: "r", cell: (p) => podTokens(p).toLocaleString("en-US") },
  { id: "sbx", header: "Sandbox s", align: "r", cell: (p) => p.costSandboxS == null ? <span className="muted">{"—"}</span> : Math.round(p.costSandboxS) },
];

/** Running first, then started desc. */
export const orderPods = (pods: Pod[]) => [...pods].sort((a, b) => Number(live(b.status)) - Number(live(a.status)) || b.startedAt - a.startedAt);

export function PodTable({ pods, now, selected, onSelect, isNew, renderExpanded }: { pods: Pod[]; now: number; selected: string | null; onSelect: (id: string) => void; isNew?: (p: Pod) => boolean; renderExpanded: (p: Pod) => ReactNode }) {
  return <DataTable columns={cols(now)} rows={pods} rowKey={(p) => p.id} selectedKey={selected} onSelect={onSelect} renderExpanded={renderExpanded} label="pods" rowClass={(p) => (isNew?.(p) ? css.flash : undefined)} />;
}

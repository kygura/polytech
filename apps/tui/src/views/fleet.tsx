import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useFetch } from "../api";
import { big, clamp, elapsed, hhmm, int, left } from "../fmt";
import type { Fleet as FleetT, Pod } from "../types";
import { type Col, type Ctx, Err, Pane, Table } from "../ui";

const BUILT_IN_ROLES = ["rules", "source", "base_rate", "news", "red_team"];
const GLYPH: Record<string, [string, string | undefined]> = { queued: ["○", "gray"], running: ["◐", "cyan"], done: ["●", "green"], failed: ["✗", "red"] };
const STATUS_COLOR: Record<string, string> = { queued: "gray", running: "cyan", judging: "cyan", done: "green", failed: "red" };
const tokens = (p: Pod) => p.agents.reduce((t, a) => t + (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0), 0);
/** Roles present in these pods: built-ins first (in order), then custom roles as first seen, judge last. */
export function rolesOf(pods: Pod[]): string[] {
  const seen = new Set(pods.flatMap((p) => p.agents.map((a) => a.role)));
  const builtIn = BUILT_IN_ROLES.filter((r) => seen.has(r));
  const custom = [...seen].filter((r) => !BUILT_IN_ROLES.includes(r) && r !== "judge");
  return [...builtIn, ...custom, ...(seen.has("judge") ? ["judge"] : [])];
}
const agentGlyph = (p: Pod, role: string) => GLYPH[p.agents.find((a) => a.role === role)?.status ?? "queued"] ?? GLYPH.queued!;

const COLS: Col<Pod>[] = [
  { h: "Pod", w: 6, cell: (p) => p.id.slice(0, 6) },
  { h: "Market", w: 36, cell: (p) => left(p.question ?? "—", 36) },
  { h: "Trigger", w: 10, cell: (p) => left(p.trigger, 10) },
  { h: "Started", w: 7, cell: (p) => hhmm(p.startedAt) },
  { h: "Elapsed", w: 7, r: true, cell: (p) => elapsed(Date.now() - p.startedAt) },
  { h: "Status", w: 8, cell: (p) => [p.status, STATUS_COLOR[p.status]] },
  { h: "Tokens", w: 6, r: true, cell: (p) => big(tokens(p)) },
  { h: "Sbx s", w: 5, r: true, cell: (p) => int(p.costSandboxS) },
];

export function Fleet({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState(0), [open, setOpen] = useState(false), [scroll, setScroll] = useState(0);
  const { data, error } = useFetch<FleetT>("/api/fleet", ctx.tick);
  const pods = data?.pods ?? [], cur = pods[clamp(sel, pods.length)], roles = rolesOf(pods);
  useInput(
    (ch, key) => {
      if (open && (key.escape || key.backspace || key.delete)) setOpen(false);
      else if (key.return && cur) (setOpen(true), setScroll(0));
      else if (ch === "j" || key.downArrow) open ? setScroll((s) => s + 1) : setSel((s) => clamp(s + 1, pods.length));
      else if (ch === "k" || key.upArrow) open ? setScroll((s) => Math.max(0, s - 1)) : setSel((s) => clamp(s - 1, pods.length));
    },
    { isActive: ctx.active },
  );
  if (!data) return <Err error={error} />;
  const b = data.budget;
  if (open && cur) {
    // ponytail: no log endpoint in the API; "log lines" = last 20 lines of each agent's output JSON.
    const lines = cur.agents.flatMap((a) => [`── ${a.role} · ${a.model} · ${a.status} · ${int(a.durationS)}s`, ...JSON.stringify(a.output ?? null, null, 1).split("\n").slice(-20)]);
    return (
      <Box flexDirection="column">
        <Text> pod {cur.id.slice(0, 8)}  {cur.question ?? ""}  <Text color={STATUS_COLOR[cur.status]}>{cur.status}</Text>  <Text color="gray">Esc back</Text></Text>
        <Pane title={`Agents (${cur.agents.length})`}>
          {cur.agents.map((a, i) => {
            const g = GLYPH[a.status] ?? GLYPH.queued!;
            return <Text key={i}><Text color={g[1]}>{g[0]}</Text> {left(a.role, 12)} {left(a.model, 24)} {left(a.status, 8)} {int(a.durationS, 5)}s  in {big(a.usage?.inputTokens ?? 0)} out {big(a.usage?.outputTokens ?? 0)}</Text>;
          })}
        </Pane>
        <Pane title="Output">
          {lines.slice(scroll, scroll + Math.max(3, ctx.h - cur.agents.length - 6)).map((l, i) => <Text key={i} wrap="truncate">{l}</Text>)}
        </Pane>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{` pods today ${b.podsToday}/${b.maxPodsPerDay}  sandboxes ${b.activeSandboxes}/${b.maxConcurrentSandboxes}  sandbox min ${Math.round(b.sandboxS / 60)}  tokens ${big(b.tokensIn)}/${big(b.tokensOut)}  spend $${b.spendTodayUsd.toFixed(2)}/$${b.dailySpendCapUsd}`}</Text>
      <Table
        cols={[...COLS.slice(0, 6), { h: roles.map((r) => r.charAt(0).toUpperCase()).join(" "), w: Math.max(1, roles.length * 2 - 1), cell: (p) => roles.map((r) => agentGlyph(p, r)[0]).join(" ") }, ...COLS.slice(6)]}
        rows={pods} sel={clamp(sel, pods.length)} height={ctx.h - 1} width={ctx.w}
      />
      {pods.length > 0 && <Text color="gray">  agents: {roles.map((r) => { const g = agentGlyph(cur!, r); return <Text key={r} color={g[1]}>{g[0]} </Text>; })} for selected pod · Enter → agents + output</Text>}
    </Box>
  );
}

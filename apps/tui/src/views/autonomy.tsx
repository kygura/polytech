import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { post, useFetch } from "../api";
import { hhmm, left, usd } from "../fmt";
import type { Autonomy as AutT, Mode } from "../types";
import { type Ctx, Err, MODE_COLOR, MODE_NAME } from "../ui";

const MODES: Mode[] = ["L0", "L1", "L2", "L3", "L4"];

export function Autonomy({ ctx, onMode }: { ctx: Ctx; onMode: (m: Mode) => void }) {
  const [local, setLocal] = useState(0);
  const { data, error } = useFetch<AutT>("/api/autonomy", ctx.tick + local);
  useInput(
    async (ch) => {
      const to = MODES[Number(ch)];
      if (!/^[0-4]$/.test(ch) || !to) return;
      try {
        const r = await post<{ allowed: boolean; mode: Mode; reason: string }>("/api/autonomy/mode", { to });
        if (r.allowed) (ctx.flash(`mode → ${r.mode}`, MODE_COLOR[r.mode]), onMode(r.mode));
        else ctx.flash(`disabled: ${r.reason === "EXECUTION_DISABLED" ? "Execution ships in phase 6" : r.reason}`, "yellow");
        setLocal((x) => x + 1);
      } catch (e) {
        ctx.flash((e as Error).message, "red");
      }
    },
    { isActive: ctx.active },
  );
  if (!data) return <Err error={error} />;
  const bar = (used: number, max: number) => "▏".padEnd(Math.round(Math.min(1, max ? used / max : 0) * 10) + 1, "█");
  return (
    <Box flexDirection="column">
      <Text>
        {" Mode   "}
        {MODES.map((m) => (
          <Text key={m} color={MODE_COLOR[m]} bold={m === data.mode} inverse={m === data.mode} dimColor={!data.executionEnabled && m >= "L2"}>{`${m === data.mode ? "[" : " "}${m} ${MODE_NAME[m]}${m === data.mode ? "]" : " "} `}</Text>
        ))}
        {!data.executionEnabled && <Text color="gray">     ← L2–L4 disabled: Execution ships in phase 6</Text>}
      </Text>
      <Text>{" Overrides   "}{data.categories.map((c) => `${c.category}: ${c.override ?? "inherit"}`).join("   ")}<Text color="gray">   (edit in web, only lowering allowed)</Text></Text>
      <Text>{` Limits      per-trade ${usd(data.limits.perTradeUsd)} (${Math.round(data.limits.perTradePct * 100)}%)   daily loss ${usd(data.limits.dailyLoss)}  used ${usd(data.usage.dailyRealizedLoss)} ${bar(data.usage.dailyRealizedLoss, data.limits.dailyLoss)}   open ${usd(data.usage.totalOpen)}  daily notional ${usd(data.usage.dailyNotional)}`}</Text>
      {data.gates.map((g, i) => (
        <Text key={g.gate}>{i === 0 ? " Gates       " : "             "}{left(g.gate.replace("->", "→"), 7)}{left(g.detail, ctx.w - 40)}{g.met ? <Text color="green">✓</Text> : <Text color="gray">{i === 0 ? "advisory" : "phase 6"}</Text>}</Text>
      ))}
      <Text> <Text backgroundColor="red" color="white" bold> K </Text>  KILL SWITCH → L0, cancels open orders, immediate, no undo</Text>
      <Text color="gray" bold> Events</Text>
      {data.events.slice(0, Math.max(1, ctx.h - 9)).map((e) => (
        <Text key={e.id}>{`  ${hhmm(e.ts)} `}<Text color={MODE_COLOR[e.fromMode]}>{e.fromMode}</Text>→<Text color={MODE_COLOR[e.toMode]}>{e.toMode}</Text>{`  ${left(e.scope, 8)} ${left(e.reason, 40)} ${e.actor}`}</Text>
      ))}
      {!data.events.length && <Text color="gray">  (none)</Text>}
    </Box>
  );
}

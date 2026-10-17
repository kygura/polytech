import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { post, useFetch } from "../api";
import { clamp, hhmm, int, left, num, signed, usd } from "../fmt";
import type { Autonomy as AutT, Mode, Proposal, Proposals, Recon } from "../types";
import { type Cell, type Col, type Ctx, Err, MODE_COLOR, MODE_NAME, sideColor, signColor, Table } from "../ui";

const MODES: Mode[] = ["L0", "L1", "L2", "L3", "L4"];
const money = (v: number) => "$" + v.toFixed(2);
const sideText = (p: Proposal) => (p.orderSide === "SELL" ? "SELL" : `BUY ${p.side}`);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cols = (now: number, sending: string | null): Col<Proposal>[] => [
  { h: "Market", w: 34, cell: (p) => left(p.question, 34) },
  { h: "Side", w: 7, cell: (p) => [sideText(p), sideColor(p.side)] },
  { h: "Shares", w: 6, r: true, cell: (p) => int(p.shares) },
  { h: "Limit", w: 5, r: true, cell: (p) => num(p.limitPrice) },
  { h: "Cost$", w: 8, r: true, cell: (p) => money(p.costUsd) },
  { h: "Edge¢", w: 6, r: true, cell: (p) => [signed(p.edgeC, 1), signColor(p.edgeC)] },
  {
    h: "Drift¢", w: 7, r: true, cell: (p): Cell => {
      const d = p.midNow == null ? null : (p.midNow - p.midAtProposal) * 100;
      return d != null && Math.abs(d) >= 1.5 ? ["⚠ " + signed(d, 1), "yellow"] : signed(d, 1);
    },
  },
  {
    h: "Expires", w: 8, r: true, cell: (p): Cell => {
      if (p.state === "sending" || p.id === sending) return "sending…";
      const ms = p.expiresAt - now;
      return ms < 120_000 ? ["⚠ " + mmss(ms), "yellow"] : mmss(ms);
    },
  },
];
/** DESIGN 8.4 texts. */
function reconLine(r: Recon | null | undefined, now: number): [string, string] {
  if (!r?.status || r.at == null) return ["recon — not run yet", "gray"];
  const at = hhmm(r.at), ago = `(${Math.round((now - r.at) / 60_000)} min ago)`;
  if (r.status === "mismatch") return [`recon ✗ MISMATCH · new orders halted · ${at}${r.detail ? ` · ${left(r.detail, 40).trim()}` : ""}`, "red"];
  if (r.status === "late") return [`recon ⚠ late · ${at} ${ago}`, "yellow"];
  return [`recon ✓ ok · ${at} ${ago}`, "gray"];
}
const RECENT_COLOR: Record<string, string> = { sent: "green", rejected: "gray", failed: "red" };
const recentText = (p: Proposal): [string, string] =>
  p.state === "expired" ? [`${hhmm(p.createdAt)} expired ${p.reason ?? ""}`.trim(), p.reason === "PRICE_MOVED" ? "yellow" : "gray"]
  : [`${hhmm(p.createdAt)} ${p.state}${p.state === "sent" && p.orderId ? ` ord ${p.orderId.slice(0, 6)}` : p.state === "failed" ? ` ${left(p.error, 40).trim()}` : ""}`, RECENT_COLOR[p.state] ?? "gray"];

export function Autonomy({ ctx, onMode }: { ctx: Ctx; onMode: (m: Mode) => void }) {
  const [local, setLocal] = useState(0);
  const [sel, setSel] = useState(0), [sending, setSending] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const { data, error } = useFetch<AutT>("/api/autonomy", ctx.tick + local);
  const props = useFetch<Proposals>("/api/proposals", ctx.tick + local).data;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000); // countdowns tick client-side (8.7)
    return () => clearInterval(t);
  }, []);
  const atL2 = ctx.mode >= "L2", pending = atL2 ? (props?.pending ?? []) : [];
  const cur = pending[clamp(sel, pending.length)];
  const decide = async (p: Proposal, action: "approve" | "reject") => {
    if (action === "approve") setSending(p.id);
    try {
      const r = await post<{ state: string; orderId?: string; error?: string; reason?: string }>(`/api/proposals/${p.id}`, { action, via: "tui" });
      if (r.state === "sent") ctx.flash(`sent ord ${(r.orderId ?? "").slice(0, 6)}`, "green");
      else if (r.state === "rejected") ctx.flash("rejected");
      else if (r.state === "expired") ctx.flash(`expired ${r.reason ?? ""}`.trim(), "yellow");
      else ctx.flash(`failed: ${r.error ?? r.state}`, "red");
    } catch (e) {
      ctx.flash(`failed: ${(e as Error).message}`, "red");
    }
    setSending(null);
    setLocal((x) => x + 1);
  };
  useInput(
    async (ch, key) => {
      if (ch === "j" || key.downArrow) return setSel((s) => clamp(s + 1, pending.length));
      if (ch === "k" || key.upArrow) return setSel((s) => clamp(s - 1, pending.length));
      if ((ch === "a" || ch === "x") && cur && cur.state === "pending" && cur.id !== sending) {
        if (ch === "x") return void decide(cur, "reject");
        if (data?.recon?.status === "mismatch") return ctx.flash("orders halted: recon mismatch", "red");
        return ctx.confirm(`SEND LIVE: ${sideText(cur)} ${int(cur.shares)} @ ${num(cur.limitPrice)} = ${money(cur.costUsd)} ? y = confirm, any other key aborts`, "y", () => void decide(cur, "approve"));
      }
      const to = MODES[Number(ch)];
      if (!/^[0-4]$/.test(ch) || !to) return;
      try {
        const r = await post<{ allowed: boolean; mode: Mode; reason: string }>("/api/autonomy/mode", { to });
        if (r.allowed) (ctx.flash(`mode → ${r.mode}`, MODE_COLOR[r.mode]), onMode(r.mode));
        else ctx.flash(`disabled: ${to >= "L3" ? "L3–L4 ship in phase 7" : to === "L2" ? "L2 needs a configured exchange" : r.reason}`, "yellow");
        setLocal((x) => x + 1);
      } catch (e) {
        ctx.flash((e as Error).message, "red");
      }
    },
    { isActive: ctx.active },
  );
  if (!data) return <Err error={error} />;
  const bar = (used: number, max: number) => "▏".padEnd(Math.round(Math.min(1, max ? used / max : 0) * 10) + 1, "█");
  const exch = data.exchangeConfigured ?? data.executionEnabled, off = (m: Mode) => m >= "L3" || (m === "L2" && !exch);
  const [rText, rColor] = reconLine(data.recon, now);
  const apLines = 2 + (pending.length ? Math.min(pending.length, 5) + 1 : 1);
  return (
    <Box flexDirection="column">
      <Text>
        {" Mode   "}
        {MODES.map((m) => (
          <Text key={m} color={MODE_COLOR[m]} bold={m === data.mode} inverse={m === data.mode} dimColor={off(m)}>{`${m === data.mode ? "[" : " "}${m} ${MODE_NAME[m]}${m === data.mode ? "]" : " "} `}</Text>
        ))}
        <Text color="gray">{`     ← ${exch ? "" : "L2 needs a configured exchange · "}L3–L4 ship in phase 7`}</Text>
      </Text>
      {atL2 ? (
        <>
          <Box width={ctx.w} justifyContent="space-between">
            <Text bold>{` Approvals ${pending.length} pending`}</Text>
            <Text color={rColor}>{rText} </Text>
          </Box>
          {pending.length
            ? <Table cols={cols(now, sending)} rows={pending} sel={clamp(sel, pending.length)} height={Math.min(pending.length, 5) + 1} width={ctx.w} />
            : <Text color="gray">  no pending approvals</Text>}
          <Text>
            <Text color="gray">{"  recent "}</Text>
            {(props?.recent ?? []).slice(0, 3).map((p) => { const [t, c] = recentText(p); return <Text key={p.id} color={c}>{` ${t} `}</Text>; })}
          </Text>
        </>
      ) : <Text color="gray"> approvals appear at L2</Text>}
      <Text>{" Overrides   "}{data.categories.map((c) => `${c.category}: ${c.override ?? "inherit"}`).join("   ")}<Text color="gray">   (edit in web, only lowering allowed)</Text></Text>
      <Text>{` Limits      per-trade ${usd(data.limits.perTradeUsd)} (${Math.round(data.limits.perTradePct * 100)}%)   daily loss ${usd(data.limits.dailyLoss)}  used ${usd(data.usage.dailyRealizedLoss)} ${bar(data.usage.dailyRealizedLoss, data.limits.dailyLoss)}   open ${usd(data.usage.totalOpen)}  daily notional ${usd(data.usage.dailyNotional)}`}</Text>
      {data.gates.map((g, i) => (
        <Text key={g.gate}>{i === 0 ? " Gates       " : "             "}{left(g.gate.replace("->", "→"), 7)}{left(g.detail, ctx.w - 40)}{g.met ? <Text color="green">✓</Text> : <Text color="gray">{i === 0 ? "advisory" : "phase 6"}</Text>}</Text>
      ))}
      <Text> <Text backgroundColor="red" color="white" bold> K </Text>  KILL SWITCH → L0, cancels open orders, immediate, no undo</Text>
      <Text color="gray" bold> Events</Text>
      {ctx.killFailed.map((f) => <Text key={f.orderId} color="red">{`  KILL FAILED ord ${f.orderId.slice(0, 6)}… not cancelled: ${left(f.error, 60).trim()}`}</Text>)}
      {data.events.slice(0, Math.max(1, ctx.h - 9 - (atL2 ? apLines : 1) - ctx.killFailed.length)).map((e) => (
        <Text key={e.id}>{`  ${hhmm(e.ts)} `}<Text color={MODE_COLOR[e.fromMode]}>{e.fromMode}</Text>→<Text color={MODE_COLOR[e.toMode]}>{e.toMode}</Text>{`  ${left(e.scope, 8)} ${left(e.reason, 40)} ${e.actor}`}</Text>
      ))}
      {!data.events.length && <Text color="gray">  (none)</Text>}
    </Box>
  );
}

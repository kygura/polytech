import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { post, useFetch } from "../api";
import { clamp, hhmm, int, left, num, signed, usd } from "../fmt";
import type { Autonomy as AutT, Mode, Proposal, Proposals, Recon, SetView } from "../types";
import { type Cell, type Col, type Ctx, Err, MODE_COLOR, MODE_NAME, sideColor, signColor, Table } from "../ui";

const MODES: Mode[] = ["L0", "L1", "L2", "L3", "L4"];
const money = (v: number) => "$" + v.toFixed(2);
const sideText = (p: Proposal) => (p.orderSide === "SELL" ? "SELL" : `BUY ${p.side}`);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const expires = (at: number, now: number): Cell => {
  const ms = at - now;
  return ms < 120_000 ? ["⚠ " + mmss(ms), "yellow"] : mmss(ms);
};
// Selectable rows are proposals (single, exit) and sets; legs and fallback reasons are detail lines (DESIGN 9.5).
type Item = { k: "p"; p: Proposal } | { k: "s"; s: SetView };
type Row = Item | { k: "leg"; s: SetView; i: number } | { k: "why"; text: string };
const setTitle = (s: SetView) => s.legs[0]?.question ?? s.eventId;
/** 9.2 TUI texts for a set's progress or outcome. */
export function setState(s: SetView): [string, string] {
  const n = s.legs.length;
  switch (s.state) {
    case "sending": return [`sending ${Math.min(n, s.legs.filter((l) => l.state === "filled").length + 1)}/${n}`, "gray"];
    case "filled": return [`filled ${n}/${n}`, "green"];
    case "unwinding": case "unwound": return [s.state, "yellow"];
    case "failed": case "flagged": return [s.state, "red"];
    case "acknowledged": return ["flagged · acknowledged", "gray"];
    default: return [s.state, "gray"];
  }
}
/** 9.3: orders carry approval auto|user + modeAtSend, proposals and sets decidedVia. */
const approvalOf = (x: { approval?: string | null; modeAtSend?: string | null; decidedVia?: string | null }): [string, string] => {
  if (x.approval !== "auto" && x.decidedVia !== "auto") return ["user", "gray"];
  const m = x.modeAtSend === "L3" || x.modeAtSend === "L4" ? x.modeAtSend : null;
  return m ? [`auto ${m}`, MODE_COLOR[m]] : ["auto", MODE_COLOR.L3];
};
const FALLBACK: Record<string, (cost: number, l3?: { perTradeUsd: number; dailyNotional: number }) => string> = {
  PER_TRADE: (c, l) => `over L3 per-trade${l ? ` $${l.perTradeUsd}` : ""} (this ${money(c)})`,
  DAILY_AUTO_NOTIONAL: (_, l) => `daily auto notional${l ? ` $${l.dailyNotional}` : ""} used`,
  CATEGORY_NOT_ALLOWED: () => "category not in L3 allowlist",
  STRUCTURAL_AUTO_OFF: () => "sets need structural auto (Settings)",
};
/** 9.7 gate text, each criterion colored separately; L1→L2 keeps the server detail. */
function gateText(g: AutT["gates"][number]): [string, boolean][] {
  const c = (v: number | null | undefined) => (v == null ? "—" : `${signed(v, 1)}¢`);
  if (g.gate === "L2->L3") { const n = g.approvedTrades ?? 0, s = g.avgSlippageC; return [[`${n}/30 approved trades`, n >= 30], [s == null ? "avg slip —" : `avg slip ${c(s)} vs ≤ 1.0¢`, s != null && Math.abs(s) <= 1]]; }
  if (g.gate === "L3->L4") { const n = g.liveTrades ?? 0, e = g.realizedEdge30dC; return [[`${n}/100 live trades`, n >= 100], [`realized edge 30d ${c(e)}`, e != null && e > 0]]; }
  return [[g.detail, g.met]];
}
const cols = (now: number, sending: string | null, open: string | null): Col<Row>[] => [
  { h: "Market", w: 34, cell: (r) => r.k === "s" ? left(`${r.s.id === open ? "▾" : "▸"} SET ${r.s.setKind} ${r.s.legs.length} legs ${setTitle(r.s)}`, 34)
    : r.k === "p" && r.p.kind === "exit" ? [left(`EXIT ${r.p.exitReason ?? ""} ${r.p.question}`.replace("  ", " "), 34), "yellow"] : r.k === "p" ? left(r.p.question, 34) : "" },
  { h: "Side", w: 8, cell: (r) => r.k === "s" ? (r.s.setKind === "buy-all" ? "BUY ALL" : "SELL ALL") : r.k === "p" ? (r.p.kind === "exit" ? `SELL ${r.p.side}` : [sideText(r.p), sideColor(r.p.side)]) : "" },
  { h: "Shares", w: 6, r: true, cell: (r) => (r.k === "s" ? int(r.s.shares) : r.k === "p" ? int(r.p.shares) : "") },
  { h: "Limit", w: 6, r: true, cell: (r) => r.k === "s" ? `Σ${num(r.s.legs.reduce((t, l) => t + l.capPrice, 0))}` : r.k === "p" ? (r.p.kind === "exit" ? `≥${num(r.p.limitPrice)}` : num(r.p.limitPrice)) : "" },
  { h: "Cost$", w: 9, r: true, cell: (r) => (r.k === "s" ? `Σ${money(r.s.costUsd)}` : r.k === "p" ? (r.p.kind === "exit" ? `+${money(r.p.costUsd)}` : money(r.p.costUsd)) : "") },
  { h: "Edge¢", w: 9, r: true, cell: (r) => r.k === "s" ? [`lock ${num(r.s.lockedC, 1)}¢`, "green"] : r.k === "p" ? (r.p.kind === "exit" ? "—" : [signed(r.p.edgeC, 1), signColor(r.p.edgeC)]) : "" },
  { h: "E[P]$", w: 9, r: true, cell: (r) => { if (r.k !== "s" && r.k !== "p") return ""; const v = r.k === "s" ? r.s.expectedProfitUsd : r.p.expectedProfitUsd; return [(v < 0 ? "-" : "+") + money(Math.abs(v)), signColor(v)]; } },
  {
    h: "Drift¢", w: 7, r: true, cell: (r): Cell => {
      if (r.k !== "p") return r.k === "s" ? "—" : "";
      const d = r.p.midNow == null ? null : (r.p.midNow - r.p.midAtProposal) * 100;
      return d != null && Math.abs(d) >= 1.5 ? ["⚠ " + signed(d, 1), "yellow"] : signed(d, 1);
    },
  },
  {
    h: "Expires", w: 10, r: true, cell: (r): Cell => {
      if (r.k === "s") return r.s.state !== "pending" ? setState(r.s) : r.s.id === sending ? "sending…" : expires(r.s.expiresAt, now);
      if (r.k !== "p") return "";
      if (r.p.state === "sending" || r.p.id === sending) return "sending…";
      return expires(r.p.expiresAt, now);
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
  : [`${hhmm(p.createdAt)} ${p.kind === "exit" ? "EXIT " : ""}${p.state}${p.state === "sent" && p.orderId ? ` ord ${p.orderId.slice(0, 6)}` : p.state === "failed" ? ` ${left(p.error, 40).trim()}` : ""}`, RECENT_COLOR[p.state] ?? "gray"];
const recentSet = (s: SetView): [string, string] => { const [t, c] = setState(s); return [`${hhmm(s.createdAt)} ${t}`, c]; };

export function Autonomy({ ctx, onMode }: { ctx: Ctx; onMode: (m: Mode) => void }) {
  const [local, setLocal] = useState(0);
  const [sel, setSel] = useState(0), [sending, setSending] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const { data, error } = useFetch<AutT>("/api/autonomy", ctx.tick + local);
  const props = useFetch<Proposals>("/api/proposals", ctx.tick + local).data;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000); // countdowns tick client-side (8.7)
    return () => clearInterval(t);
  }, []);
  const atL2 = ctx.mode >= "L2";
  const items: Item[] = atL2 ? [...(props?.sets?.pending ?? []).map((s): Item => ({ k: "s", s })), ...(props?.pending ?? []).map((p): Item => ({ k: "p", p }))] : [];
  // j/k walk the flagged sets first (A acks the selected one), then the proposal rows.
  const flagged = (props?.sets?.recent ?? []).filter((s) => s.state === "flagged");
  const nSel = flagged.length + items.length, at = clamp(sel, nSel);
  const fcur = at < flagged.length ? flagged[at] : undefined, cur = fcur ? undefined : items[at - flagged.length];
  const decideSet = async (s: SetView, action: "approve" | "reject") => {
    if (action === "approve") setSending(s.id);
    try {
      const r = await post<{ state: string; error?: string; reason?: string }>(`/api/sets/${s.id}`, { action, via: "tui" });
      const [t, c] = setState({ ...s, state: r.state, legs: r.state === "filled" ? s.legs.map((l) => ({ ...l, state: "filled" })) : s.legs });
      ctx.flash(r.state === "expired" ? `expired ${r.reason ?? ""}`.trim() : `set ${t}${r.error ? `: ${r.error}` : ""}`, r.state === "expired" ? "yellow" : c);
    } catch (e) {
      ctx.flash(`failed: ${(e as Error).message}`, "red");
    }
    setSending(null);
    setLocal((x) => x + 1);
  };
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
      if (ch === "j" || key.downArrow) return setSel((s) => clamp(s + 1, nSel));
      if (ch === "k" || key.upArrow) return setSel((s) => clamp(s - 1, nSel));
      if (ch === "A" && fcur) {
        try {
          await post(`/api/sets/${fcur.id}/ack`);
          ctx.flash("acknowledged", "green");
        } catch (e) {
          ctx.flash(`ack failed: ${(e as Error).message}`, "red");
        }
        return setLocal((x) => x + 1);
      }
      const it = cur?.k === "p" ? cur.p : cur?.s;
      if ((ch === "a" || ch === "x") && cur && it && it.state === "pending" && it.id !== sending) {
        if (ch === "x") return void (cur.k === "p" ? decide(cur.p, "reject") : decideSet(cur.s, "reject"));
        if (data?.recon?.status === "mismatch") return ctx.flash("orders halted: recon mismatch", "red");
        if (cur.k === "s") {
          const s = cur.s;
          return ctx.confirm(`SEND LIVE SET: ${s.setKind} ${s.legs.length} legs × ${int(s.shares)} = ${money(s.costUsd)} ? y = confirm, any other key aborts`, "y", () => void decideSet(s, "approve"));
        }
        const p = cur.p, what = p.kind === "exit" ? `SELL ${p.side} ${int(p.shares)} @ ≥ ${num(p.limitPrice)} = +${money(p.costUsd)}` : `${sideText(p)} ${int(p.shares)} @ ${num(p.limitPrice)} = ${money(p.costUsd)}`;
        return ctx.confirm(`SEND LIVE: ${what} ? y = confirm, any other key aborts`, "y", () => void decide(p, "approve"));
      }
      const to = MODES[Number(ch)];
      if (!/^[0-4]$/.test(ch) || !to) return;
      try {
        const r = await post<{ allowed: boolean; mode: Mode; reason: string }>("/api/autonomy/mode", { to });
        if (r.allowed) (ctx.flash(`mode → ${r.mode}`, MODE_COLOR[r.mode]), onMode(r.mode));
        else ctx.flash(`refused: ${r.reason}`, "yellow");
        setLocal((x) => x + 1);
      } catch (e) {
        ctx.flash((e as Error).message, "red");
      }
    },
    { isActive: ctx.active },
  );
  if (!data) return <Err error={error} />;
  const bar = (used: number, max: number) => "▏".padEnd(Math.round(Math.min(1, max ? used / max : 0) * 10) + 1, "█");
  const exch = data.exchangeConfigured ?? data.executionEnabled, off = (m: Mode) => m >= "L2" && !exch;
  const [rText, rColor] = reconLine(data.recon, now);
  const selIdx = at - flagged.length, open = cur?.k === "s" ? cur.s.id : null;
  const rows: Row[] = [];
  let selRow = -1; // -1: selection is on a flagged block line
  items.forEach((it, i) => {
    if (i === selIdx) selRow = rows.length;
    rows.push(it);
    if (it.k === "s" && it.s.id === open) it.s.legs.forEach((_, j) => rows.push({ k: "leg", s: it.s, i: j }));
    const x = it.k === "p" ? it.p : it.s, why = x.fallbackReason && (FALLBACK[x.fallbackReason]?.(x.costUsd, data.limits.l3) ?? x.fallbackReason);
    if (why) rows.push({ k: "why", text: `L3 fallback: ${why}` });
  });
  const line = (r: Row) => {
    if (r.k === "why") return <Text color="gray">{`     ${r.text}`}</Text>;
    if (r.k !== "leg") return null;
    const l = r.s.legs[r.i]!, busy = r.s.state === "sending" || r.s.state === "unwinding";
    return <Text>{`     ${r.i + 1}/${r.s.legs.length} `}<Text color={sideColor(l.token)}>{left(l.token, 4)}</Text>{`${left(l.question, 24)} cap ${num(l.capPrice)}  ${int(l.shares)}`}{busy && <Text color="gray">{`  ${l.state}`}</Text>}</Text>;
  };
  const recent = [...(props?.recent ?? []).map((p) => ({ at: p.createdAt, t: recentText(p), a: p.state === "sent" ? approvalOf(p) : null, id: p.id })),
    ...(props?.sets?.recent ?? []).map((s) => ({ at: s.createdAt, t: recentSet(s), a: s.state === "filled" || s.state === "flagged" ? approvalOf(s) : null, id: s.id }))].sort((a, b) => b.at - a.at);
  const tableH = Math.min(rows.length, 8) + 1;
  const flagLines = flagged.reduce((t, s) => t + Math.max(1, s.held.length), 0);
  const apLines = 2 + (rows.length ? tableH : 1);
  return (
    <Box flexDirection="column">
      {flagged.flatMap((s) => {
        const head = `FLAGGED set · ${s.setKind} · ${left(setTitle(s), 30).trim()}`;
        return s.held.length
          ? s.held.map((h, j) => <Text key={`${s.id}:${h.conditionId}`} color="red" bold inverse={s === fcur && j === 0} wrap="truncate">{`${s === fcur && j === 0 ? "▶" : " "}${head} · holds ${h.token} ${int(h.shares)} "${left(h.question, 24).trim()}" avg ${num(h.avgFill)} bid ${num(h.bidNow)} · suggested: SELL ${int(h.shares)} ${h.token}`}</Text>)
          : [<Text key={s.id} color="red" bold inverse={s === fcur} wrap="truncate">{`${s === fcur ? "▶" : " "}${head} · suggested: ${s.suggestedAction ?? "check positions on Polymarket"}`}</Text>];
      })}
      {flagged.length > 0 && <Text color="gray">{"  j/k select · A acknowledge selected (closes nothing) · the engine will not retry"}</Text>}
      <Text>
        {" Mode   "}
        {MODES.map((m) => (
          <Text key={m} color={MODE_COLOR[m]} bold={m === data.mode} inverse={m === data.mode} dimColor={off(m)}>{`${m === data.mode ? "[" : " "}${m} ${MODE_NAME[m]}${m === data.mode ? "]" : " "} `}</Text>
        ))}
        {!exch && <Text color="gray">{"     ← L2–L4 need a configured exchange (PM_PRIVATE_KEY on the server)."}</Text>}
      </Text>
      {atL2 ? (
        <>
          <Box width={ctx.w} justifyContent="space-between">
            <Text bold>{` Approvals ${items.length} pending`}</Text>
            <Text color={rColor}>{rText} </Text>
          </Box>
          {rows.length
            ? <Table cols={cols(now, sending, open)} rows={rows} sel={selRow} height={tableH} width={ctx.w} line={line} />
            : <Text color="gray">  no pending approvals</Text>}
          <Text wrap="truncate">
            <Text color="gray">{"  recent "}</Text>
            {recent.slice(0, 3).map((r) => <Text key={r.id}><Text color={r.t[1]}>{` ${r.t[0]}`}</Text>{r.a && <Text color={r.a[1]}>{` ${r.a[0]}`}</Text>}{" "}</Text>)}
          </Text>
        </>
      ) : <Text color="gray"> approvals appear at L2</Text>}
      <Text>{" Overrides   "}{data.categories.map((c) => `${c.category}: ${c.override ?? "inherit"}`).join("   ")}<Text color="gray">   (edit in web, only lowering allowed)</Text></Text>
      <Text>{` Limits      per-trade ${usd(data.limits.perTradeUsd)} (${Math.round(data.limits.perTradePct * 100)}%)   daily loss ${usd(data.limits.dailyLoss)}  used ${usd(data.usage.dailyRealizedLoss)} ${bar(data.usage.dailyRealizedLoss, data.limits.dailyLoss)}   open ${usd(data.usage.totalOpen)}  daily notional ${usd(data.usage.dailyNotional)}`}</Text>
      {data.gates.map((g, i) => {
        const parts = gateText(g), len = parts.reduce((t, [x], j) => t + x.length + (j ? 3 : 0), 0);
        return (
          <Text key={g.gate}>{i === 0 ? " Gates       " : "             "}{left(g.gate.replace("->", "→"), 7)}
            {parts.map(([x, met], j) => <Text key={j}>{j ? <Text color="gray">{" · "}</Text> : null}<Text color={met ? "green" : "gray"}>{x}</Text></Text>)}
            {" ".repeat(Math.max(1, ctx.w - 30 - len))}{g.met ? <Text color="green">✓</Text> : <Text color="gray">advisory</Text>}</Text>
        );
      })}
      <Text> <Text backgroundColor="red" color="white" bold> K </Text>  KILL SWITCH → L0, cancels open orders, immediate, no undo</Text>
      <Text color="gray" bold> Events</Text>
      {ctx.killFailed.map((f) => <Text key={f.orderId} color="red">{`  KILL FAILED ord ${f.orderId.slice(0, 6)}… not cancelled: ${left(f.error, 60).trim()}`}</Text>)}
      {data.events.slice(0, Math.max(1, ctx.h - 9 - (atL2 ? apLines : 1) - ctx.killFailed.length - flagLines - (flagged.length ? 1 : 0))).map((e) => (
        <Text key={e.id}>{`  ${hhmm(e.ts)} `}<Text color={MODE_COLOR[e.fromMode]}>{e.fromMode}</Text>→<Text color={MODE_COLOR[e.toMode]}>{e.toMode}</Text>{`  ${left(e.scope, 8)} ${left(e.reason, 40)} ${e.actor}`}</Text>
      ))}
      {!data.events.length && <Text color="gray">  (none)</Text>}
    </Box>
  );
}

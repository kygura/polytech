"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DataTable, type Column } from "./DataTable";
import { EdgeBadge } from "./EdgeBadge";
import { NumCell } from "./NumCell";
import { Flat, MarketTitle } from "./pageParts";
import { Button, Panel } from "./ui";
import { hm, truncate } from "./fmt";
import { approvalChip, countdown, drift, fallbackText, reconText, setStateText, stateText, usd2, type Proposal, type Recon, type SetLeg, type SetView } from "./live";
import css from "./panels.module.css";
import ui from "./ui.module.css";
import btn from "./ui/ui.module.css";

export function ReconStatus({ recon, now }: { recon: Recon | null | undefined; now: number }) {
  const r = reconText(recon, now);
  return <span className={`ui ${r.cls}`} title={r.title}>recon <span className={r.glyphCls}>{r.glyph}</span> {r.text}{recon?.status === "mismatch" && <> <Rebaseline /></>}</span>;
}

/** Mismatch only. Confirm step (10 s, Esc cancels, like Approve), then POST /api/recon/rebaseline. needsAck 409 (failed_unknown order newer than the baseline): diff plus a second confirm that re-POSTs {ack:true}. Other 409s: error text only. */
function Rebaseline() {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [ackPrompt, setAckPrompt] = useState<{ error: string; diff?: string } | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null), openRef = useRef<HTMLButtonElement>(null), ackCancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setConfirm(false), 10_000);
    return () => clearTimeout(t);
  }, [confirm]);
  // Cancel gets focus, not the override: the override is one Tab away.
  useEffect(() => { if (ackPrompt) ackCancelRef.current?.focus(); }, [ackPrompt]);
  const cancel = () => { setConfirm(false); setAckPrompt(null); setTimeout(() => openRef.current?.focus()); };
  const run = async (ack = false) => {
    setConfirm(false); setAckPrompt(null); setBusy(true); setErr(null);
    const r = await fetch("/api/recon/rebaseline", ack ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ack: true }) } : { method: "POST" }).catch(() => null);
    setBusy(false);
    if (r?.ok) return router.refresh();
    const j = await r?.json().catch(() => null);
    if (j?.needsAck) return setAckPrompt({ error: j.error, diff: j.diff });
    setErr(j?.error ?? `Re-baseline failed: ${r ? r.status : "network error"}`);
  };
  return (
    <>
      {confirm ? (
        <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
          <span className="ui">Re-baseline recon to current exchange balance?</span>
          <button type="button" className={`${btn.btn} ${btn.sm}`} ref={confirmRef} onClick={() => void run()}>Confirm</button>
          <Button size="sm" onClick={cancel}>Cancel</Button>
        </span>
      ) : ackPrompt ? (
        <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
          <span role="alert" className="down ui">{ackPrompt.error}</span>
          {ackPrompt.diff && ackPrompt.diff !== "none" && ackPrompt.diff.split("; ").map((t) => <span key={t} className="ui muted">{t}</span>)}
          <Button size="sm" onClick={() => void run(true)}>I checked the venue — re-baseline anyway</Button>
          <button type="button" className={`${btn.btn} ${btn.sm}`} ref={ackCancelRef} onClick={cancel}>Cancel</button>
        </span>
      ) : (
        <button type="button" className={`${btn.btn} ${btn.sm}`} ref={openRef} disabled={busy} onClick={() => setConfirm(true)}>{busy ? "Re-baselining…" : "Re-baseline"}</button>
      )}
      {err && <span role="alert" className="down ui">{err}</span>}
    </>
  );
}

const SideCell = ({ p }: { p: Proposal }) => (p.kind === "exit" ? <span>SELL {p.side}</span> : p.orderSide === "SELL" ? <span>SELL</span> : <span className={p.side === "YES" ? "yes" : "no"}>BUY {p.side}</span>);
const Shown = ({ s }: { s: { text: string; cls: string; title?: string } }) => <span className={s.cls} title={s.title}>{s.text}</span>;
const market = (p: Proposal) => <MarketTitle id={p.conditionId} question={p.question} />;
const Chip = ({ text, color }: { text: string; color: string }) => <span className={css.chip} style={{ borderColor: color, color, marginLeft: 0, marginRight: "var(--sp-1)" }}>{text}</span>;
const SET_CHIP = <Chip text="SET" color="var(--border)" />;
const EXIT_CHIP = <Chip text="EXIT" color="var(--warn)" />;
const sub = (t: string | null) => t && <div className="muted ui" style={{ fontSize: "var(--fs-xs)" }}>{t}</div>;
const setTitle = (s: SetView) => truncate(`${s.setKind} · ${s.legs.length} legs · ${s.legs[0]?.question ?? s.eventId}`, 48);
const capSum = (s: SetView) => s.legs.reduce((t, l) => t + l.capPrice, 0);
const LEG_CLS: Record<string, string> = { filled: "up", queued: "muted", unwinding: "warn", unwound: "warn", held: "down", failed: "down" };
const LEG_TEXT: Record<string, string> = { sending: "sending…", unwinding: "unwinding…" };

type Decide = (id: string, a: "approve" | "reject", set?: boolean) => Promise<void>;
type Ask = { text: string; confirmLabel: string; approveLabel: string; rejectLabel: string };

/** Approve → inline confirm (10 s, Esc cancels) → POST; Reject posts at once. `busy` (sending/unwinding) replaces the buttons. The server decides expiry; the row only reflects it. */
function Actions({ id, set, busy, ask, halted, onDecide }: { id: string; set?: boolean; busy: { text: string; cls: string } | null; ask: Ask; halted: string | null; onDecide: Decide }) {
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null), approveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setConfirm(false), 10_000);
    return () => clearTimeout(t);
  }, [confirm]);
  const cancel = () => { setConfirm(false); setTimeout(() => approveRef.current?.focus()); };
  if (busy) return <span className={`${busy.cls} ui`} style={{ display: "inline-flex", gap: "var(--sp-1)", alignItems: "center" }}>{busy.text} <span className={ui.spinner} aria-hidden /></span>;
  if (confirm && !halted)
    return (
      <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
        <span className="ui">{ask.text}</span>
        <button type="button" className={`${btn.btn} ${btn.sm}`} ref={confirmRef} style={{ background: "var(--warn)", borderColor: "var(--warn)", color: "var(--on-focus)" }}
          aria-label={ask.confirmLabel} onClick={() => { setConfirm(false); void onDecide(id, "approve", set); }}>Confirm</button>
        <Button size="sm" onClick={cancel}>Cancel</Button>
      </span>
    );
  return (
    <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }}>
      {halted
        ? <span className="muted ui" title={halted}>orders halted</span>
        : <button type="button" className={`${btn.btn} ${btn.sm}`} ref={approveRef} style={{ borderColor: "var(--warn)" }} onClick={() => setConfirm(true)} aria-label={ask.approveLabel}>Approve</button>}
      <Button size="sm" onClick={() => void onDecide(id, "reject", set)} aria-label={ask.rejectLabel}>Reject</Button>
    </span>
  );
}

const askSingle = (p: Proposal): Ask => {
  const cost = usd2(p.costUsd), px = p.limitPrice.toFixed(3);
  return {
    text: p.kind === "exit" ? `Sell ${p.shares} ${p.side} @ ≥ ${px} live?` : `Send ${cost} live?`,
    confirmLabel: `Send live order: ${p.orderSide.toLowerCase()} ${p.side} ${p.shares} shares at ${px}, ${p.kind === "exit" ? "proceeds" : "cost"} ${cost}`,
    approveLabel: `Approve: ${p.orderSide} ${p.side} ${p.shares} shares, ${p.kind === "exit" ? "proceeds" : "cost"} ${cost}`,
    rejectLabel: `Reject: ${p.orderSide} ${p.side} ${p.shares} shares`,
  };
};
const askSet = (s: SetView): Ask => {
  const n = s.legs.length, cost = usd2(s.costUsd), what = s.setKind === "buy-all" ? "buy all" : "sell all";
  return {
    text: `Send set: ${n} legs, ${cost} live?`,
    confirmLabel: `Send live set: ${what}, ${n} legs of ${s.shares} shares, cost ${cost}`,
    approveLabel: `Approve set: ${what}, ${n} legs of ${s.shares} shares, cost ${cost}`,
    rejectLabel: `Reject set: ${what}, ${n} legs`,
  };
};

// Pending table rows: singles, sets, and the legs of expanded sets (DESIGN 9.1).
type Row = { k: "p"; p: Proposal } | { k: "s"; s: SetView } | { k: "leg"; s: SetView; l: SetLeg; i: number };
// Recent rows: resolved singles and sets, newest first.
type RecentRow = { k: "p"; p: Proposal } | { k: "s"; s: SetView };
const at = (r: RecentRow) => (r.k === "p" ? r.p.createdAt : r.s.createdAt);
const approvalCell = (x: Parameters<typeof approvalChip>[0]) => { const c = approvalChip(x); return c.text === "user" ? <span className="muted">user</span> : <Chip {...c} />; };

const RECENT: Column<RecentRow>[] = [
  { id: "ts", header: "ts", align: "r", cell: (r) => hm(at(r)) },
  { id: "approval", header: "Approval", align: "l", cell: (r) => approvalCell(r.k === "p" ? r.p : r.s) },
  { id: "market", header: "Market", align: "l", cell: (r) => (r.k === "p" ? <>{r.p.kind === "exit" && EXIT_CHIP}{market(r.p)}</> : <>{SET_CHIP}<span className="ui">{setTitle(r.s)}</span></>) },
  { id: "side", header: "Side", align: "l", cell: (r) => (r.k === "p" ? <SideCell p={r.p} /> : r.s.setKind === "buy-all" ? "BUY ALL" : "SELL ALL") },
  { id: "shares", header: "Shares", align: "r", cell: (r) => <NumCell value={r.k === "p" ? r.p.shares : r.s.shares} fmt="int" /> },
  { id: "limit", header: "Limit", align: "r", cell: (r) => (r.k === "p" ? <NumCell value={r.p.limitPrice} fmt="p" /> : `Σ ${capSum(r.s).toFixed(3)}`) },
  { id: "state", header: "State", align: "l", cell: (r) => <Shown s={r.k === "p" ? stateText(r.p) : setStateText(r.s)} /> },
];

export function ApprovalsPane({ mode, pending, recent, sets = { pending: [], recent: [] }, l3, recon, onDecide }: { mode: Mode; pending: Proposal[]; recent: Proposal[]; sets?: { pending: SetView[]; recent: SetView[] }; l3?: { perTradeUsd: number; dailyNotional: number }; recon: Recon | null | undefined; onDecide: Decide }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const belowL2 = mode === "L0" || mode === "L1";
  const halted = recon?.status === "mismatch" ? "Reconciliation mismatch: new orders halted" : belowL2 ? `Mode is ${mode}; approvals need L2` : null;
  const n = pending.length + sets.pending.length;
  const toggle = (id: string) => setOpen((o) => { const x = new Set(o); x.has(id) ? x.delete(id) : x.add(id); return x; });

  if (belowL2 && !n)
    return <div id="approvals"><Panel title="Pending approvals"><p className={`muted ui ${css.line}`} style={{ margin: 0 }}>Approvals appear at L2 Approve each.</p></Panel></div>;

  const rows: Row[] = [
    ...sets.pending.flatMap((s): Row[] => [{ k: "s", s }, ...(open.has(s.id) ? s.legs.map((l, i): Row => ({ k: "leg", s, l, i })) : [])]),
    ...pending.map((p): Row => ({ k: "p", p })),
  ];
  const busySet = (s: SetView) => (s.state === "sending" || s.state === "unwinding" ? setStateText(s) : null);
  const cols: Column<Row>[] = [
    { id: "market", header: "Market", align: "l", cell: (r) => {
      if (r.k === "leg") return <span style={{ paddingLeft: 16, display: "inline-flex", gap: "var(--sp-1)", alignItems: "center" }}><span className="muted">{r.i + 1}/{r.s.legs.length}</span><MarketTitle id={r.l.conditionId} question={r.l.question} /></span>;
      if (r.k === "s") {
        const x = open.has(r.s.id), first = r.s.legs[0]?.conditionId;
        return <>
          <Button size="sm" variant="ghost" aria-expanded={x} aria-label={`${x ? "Hide" : "Show"} ${r.s.legs.length} legs`} onClick={() => toggle(r.s.id)} style={{ padding: "0 var(--sp-1)", marginRight: "var(--sp-1)" }}>{x ? "▾" : "▸"}</Button>
          {SET_CHIP}{first ? <Link href={`/trade/${encodeURIComponent(first)}`} className="ui" title={setTitle(r.s)}>{setTitle(r.s)}</Link> : <span className="ui">{setTitle(r.s)}</span>}
          {sub(fallbackText(r.s.fallbackReason, r.s.costUsd, l3))}
        </>;
      }
      return <>{r.p.kind === "exit" && <>{EXIT_CHIP}<span className="muted ui">· {r.p.exitReason ?? "exit"} </span></>}{market(r.p)}{sub(fallbackText(r.p.fallbackReason, r.p.costUsd, l3))}</>;
    } },
    { id: "side", header: "Side", align: "l", cell: (r) => (r.k === "leg" ? <span className={r.l.token === "YES" ? "yes" : "no"}>{r.l.token}</span> : r.k === "s" ? (r.s.setKind === "buy-all" ? "BUY ALL" : "SELL ALL") : <SideCell p={r.p} />) },
    { id: "shares", header: "Shares", align: "r", cell: (r) => <NumCell value={r.k === "p" ? r.p.shares : r.k === "s" ? r.s.shares : r.l.shares} fmt="int" /> },
    { id: "limit", header: "Limit", align: "r", cell: (r) => (r.k === "leg" ? <NumCell value={r.l.capPrice} fmt="p" /> : r.k === "s" ? `Σ ${capSum(r.s).toFixed(3)}` : r.p.kind === "exit" ? `≥ ${r.p.limitPrice.toFixed(3)}` : <NumCell value={r.p.limitPrice} fmt="p" />) },
    { id: "cost", header: "Cost$", align: "r", cell: (r) => (r.k === "leg" ? usd2(r.l.costUsd) : r.k === "s" ? usd2(r.s.costUsd) : r.p.kind === "exit" ? `+${usd2(r.p.costUsd)}` : usd2(r.p.costUsd)) },
    { id: "edge", header: "Edge¢", align: "r", cell: (r) => (r.k === "leg" ? null : r.k === "s" ? <span className="up">lock {r.s.lockedC == null ? "—" : r.s.lockedC.toFixed(1)}¢</span> : r.p.kind === "exit" ? <span className="muted">—</span> : <EdgeBadge cents={r.p.edgeC} />) },
    { id: "ep", header: "E[P]$", align: "r", cell: (r) => (r.k === "leg" ? null : <NumCell value={r.k === "s" ? r.s.expectedProfitUsd : r.p.expectedProfitUsd} fmt="usd" signed />) },
    // Set rows: legs carry no mids yet, so drift shows —.
    { id: "drift", header: "Drift¢", align: "r", cell: (r) => (r.k === "p" ? <Shown s={drift(r.p)} /> : r.k === "s" ? <span className="muted">—</span> : null) },
    { id: "exp", header: "Expires", align: "r", cell: (r) => (r.k === "leg" ? null : <Shown s={countdown(r.k === "s" ? r.s.expiresAt : r.p.expiresAt, now)} />) },
    { id: "act", header: "", align: "l", cell: (r) => {
      if (r.k === "leg") return busySet(r.s) ? <span className={LEG_CLS[r.l.state] ?? ""}>{LEG_TEXT[r.l.state] ?? r.l.state}</span> : null;
      if (r.k === "s") return <Actions id={r.s.id} set busy={busySet(r.s)} ask={askSet(r.s)} halted={halted} onDecide={onDecide} />;
      return <Actions id={r.p.id} busy={r.p.state === "sending" ? { text: "sending…", cls: "muted" } : null} ask={askSingle(r.p)} halted={halted} onDecide={onDecide} />;
    } },
  ];
  const recentRows: RecentRow[] = [...recent.map((p): RecentRow => ({ k: "p", p })), ...sets.recent.map((s): RecentRow => ({ k: "s", s }))].sort((a, b) => at(b) - at(a));

  return (
    <div id="approvals"><Panel label="Pending approvals" title={<span aria-live="polite">Pending approvals · {n}</span>} right={<ReconStatus recon={recon} now={now} />}>
      {rows.length
        ? <Flat><DataTable columns={cols} rows={rows} rowKey={(r) => (r.k === "p" ? r.p.id : r.k === "s" ? r.s.id : `${r.s.id}:${r.i}`)} keys={false} label="pending approvals"
            rowClass={(r) => (r.k === "leg" ? `row2 ${css.legRow}` : "row2")} /></Flat>
        : <p className={`muted ui ${css.line}`} style={{ margin: 0 }}>No pending approvals.</p>}
      {recentRows.length > 0 && <>
        <div className={css.divider} style={{ paddingLeft: "var(--sp-3)" }}>Recent</div>
        <Flat><DataTable columns={RECENT} rows={recentRows} rowKey={(r) => (r.k === "p" ? r.p.id : r.s.id)} keys={false} label="recent approvals" rowClass={() => "row2"} /></Flat>
      </>}
    </Panel></div>
  );
}

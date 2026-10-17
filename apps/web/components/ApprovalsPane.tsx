"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DataTable, MarketCell, type Column } from "./DataTable";
import { EdgeBadge } from "./EdgeBadge";
import { NumCell } from "./NumCell";
import { hm } from "./fmt";
import { countdown, drift, reconText, stateText, usd2, type Proposal, type Recon } from "./live";
import css from "./panels.module.css";
import ui from "./ui.module.css";

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
          <button ref={confirmRef} type="button" onClick={() => void run()}>Confirm</button>
          <button type="button" onClick={cancel}>Cancel</button>
        </span>
      ) : ackPrompt ? (
        <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
          <span role="alert" className="neg ui">{ackPrompt.error}</span>
          {ackPrompt.diff && ackPrompt.diff !== "none" && ackPrompt.diff.split("; ").map((t) => <span key={t} className="ui muted">{t}</span>)}
          <button type="button" onClick={() => void run(true)}>I checked the venue — re-baseline anyway</button>
          <button ref={ackCancelRef} type="button" onClick={cancel}>Cancel</button>
        </span>
      ) : (
        <button ref={openRef} type="button" disabled={busy} onClick={() => setConfirm(true)}>{busy ? "Re-baselining…" : "Re-baseline"}</button>
      )}
      {err && <span role="alert" className="neg ui">{err}</span>}
    </>
  );
}

const SideCell = ({ p }: { p: Proposal }) => (p.orderSide === "SELL" ? <span>SELL</span> : <span className={p.side === "YES" ? "pos" : "neg"}>BUY {p.side}</span>);
const Shown = ({ s }: { s: { text: string; cls: string; title?: string } }) => <span className={s.cls} title={s.title}>{s.text}</span>;
const market = (p: Proposal) => <Link href={`/markets/${p.conditionId}`}><MarketCell question={p.question} category={null} max={48} /></Link>;

/** Approve → inline confirm (10 s, Esc cancels) → POST; Reject posts at once. The server decides expiry; the row only reflects it. */
function Actions({ p, halted, onDecide }: { p: Proposal; halted: string | null; onDecide: (id: string, a: "approve" | "reject") => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null), approveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setConfirm(false), 10_000);
    return () => clearTimeout(t);
  }, [confirm]);
  const cancel = () => { setConfirm(false); setTimeout(() => approveRef.current?.focus()); };
  if (p.state === "sending") return <span className="muted ui" style={{ display: "inline-flex", gap: "var(--sp-1)", alignItems: "center" }}>sending… <span className={ui.spinner} aria-hidden /></span>;
  const cost = usd2(p.costUsd);
  if (confirm && !halted)
    return (
      <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }}>
        <span className="ui">Send {cost} live?</span>
        <button ref={confirmRef} type="button" style={{ background: "var(--mode-2)", borderColor: "var(--mode-2)", color: "var(--bg)" }}
          aria-label={`Send live order: ${p.orderSide.toLowerCase()} ${p.side} ${p.shares} shares at ${p.limitPrice.toFixed(3)}, cost ${cost}`}
          onClick={() => { setConfirm(false); void onDecide(p.id, "approve"); }}>Confirm</button>
        <button type="button" onClick={cancel}>Cancel</button>
      </span>
    );
  return (
    <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }}>
      {halted
        ? <span className="muted ui" title={halted}>orders halted</span>
        : <button ref={approveRef} type="button" style={{ borderColor: "var(--mode-2)" }} onClick={() => setConfirm(true)} aria-label={`Approve: ${p.orderSide} ${p.side} ${p.shares} shares, cost ${cost}`}>Approve</button>}
      <button type="button" onClick={() => void onDecide(p.id, "reject")} aria-label={`Reject: ${p.orderSide} ${p.side} ${p.shares} shares`}>Reject</button>
    </span>
  );
}

const RECENT: Column<Proposal>[] = [
  { id: "ts", header: "ts", align: "r", cell: (p) => hm(p.createdAt) },
  { id: "market", header: "Market", align: "l", cell: market },
  { id: "side", header: "Side", align: "l", cell: (p) => <SideCell p={p} /> },
  { id: "shares", header: "Shares", align: "r", cell: (p) => <NumCell value={p.shares} fmt="int" /> },
  { id: "limit", header: "Limit", align: "r", cell: (p) => <NumCell value={p.limitPrice} fmt="p" /> },
  { id: "state", header: "State", align: "l", cell: (p) => <Shown s={stateText(p)} /> },
];

export function ApprovalsPane({ mode, pending, recent, recon, onDecide }: { mode: Mode; pending: Proposal[]; recent: Proposal[]; recon: Recon | null | undefined; onDecide: (id: string, a: "approve" | "reject") => Promise<void> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const belowL2 = mode === "L0" || mode === "L1";
  const halted = recon?.status === "mismatch" ? "Reconciliation mismatch: new orders halted" : belowL2 ? `Mode is ${mode}; approvals need L2` : null;
  const n = pending.length;

  if (belowL2 && !pending.length)
    return <section className="pane" id="approvals"><p className={`muted ui ${css.line}`} style={{ margin: 0 }}>Approvals appear at L2 Approve each.</p></section>;

  const cols: Column<Proposal>[] = [
    { id: "market", header: "Market", align: "l", cell: market },
    { id: "side", header: "Side", align: "l", cell: (p) => <SideCell p={p} /> },
    { id: "shares", header: "Shares", align: "r", cell: (p) => <NumCell value={p.shares} fmt="int" /> },
    { id: "limit", header: "Limit", align: "r", cell: (p) => <NumCell value={p.limitPrice} fmt="p" /> },
    { id: "cost", header: "Cost$", align: "r", cell: (p) => usd2(p.costUsd) },
    { id: "edge", header: "Edge¢", align: "r", cell: (p) => <EdgeBadge cents={p.edgeC} /> },
    { id: "ep", header: "E[P]$", align: "r", cell: (p) => <NumCell value={p.expectedProfitUsd} fmt="usd" signed /> },
    { id: "drift", header: "Drift¢", align: "r", cell: (p) => <Shown s={drift(p)} /> },
    { id: "exp", header: "Expires", align: "r", cell: (p) => <Shown s={countdown(p.expiresAt, now)} /> },
    { id: "act", header: "", align: "l", cell: (p) => <Actions p={p} halted={halted} onDecide={onDecide} /> },
  ];

  return (
    <section className="pane" id="approvals">
      <h2 style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)" }}>
        <span aria-live="polite">Approvals · {n} pending</span>
        <ReconStatus recon={recon} now={now} />
      </h2>
      {pending.length
        ? <DataTable columns={cols} rows={pending} rowKey={(p) => p.id} keys={false} label="pending approvals" />
        : <p className={`muted ui ${css.line}`} style={{ margin: 0 }}>No pending approvals.</p>}
      {recent.length > 0 && <>
        <div className={css.divider} style={{ paddingLeft: "var(--sp-3)" }}>Recent</div>
        <DataTable columns={RECENT} rows={recent} rowKey={(p) => p.id} keys={false} label="recent approvals" />
      </>}
    </section>
  );
}

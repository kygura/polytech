"use client";
import type { Mode } from "@pm/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApprovalsPane } from "../../../components/ApprovalsPane";
import { CategoryOverrides } from "../../../components/CategoryOverrides";
import { ErrorBar } from "../../../components/ErrorBar";
import { FlaggedSetBar } from "../../../components/FlaggedSetBar";
import { EventLog } from "../../../components/EventLog";
import { GatePanel } from "../../../components/GatePanel";
import { KillSwitchButton } from "../../../components/KillSwitchButton";
import { ModeBadge } from "../../../components/ModeBadge";
import { MODE_HELP, ModeSelector } from "../../../components/ModeSelector";
import { RiskLimits } from "../../../components/RiskLimits";
import { useSettingsForm } from "../../../components/SettingsForm";
import { killError, postKill, type Proposal, type Recon, type SetView } from "../../../components/live";
import type { read } from "../../../lib/jobs";
import type { AppSettings } from "../../../lib/jobs/settings";
import css from "../../../components/autonomy.module.css";
import pg from "../../../components/page.module.css";
import { Panel } from "../../../components/ui";

export type Autonomy = Awaited<ReturnType<typeof read.autonomy>> & { liveOpenOrders?: number; recon?: Recon | null };
type Proposals = { pending: Proposal[]; recent: Proposal[]; sets?: { pending: SetView[]; recent: SetView[] } };
const JSON_H = { "content-type": "application/json" };

const EX_WHY = "L2–L4 need a configured exchange (PM_PRIVATE_KEY on the server).";
const SIZING = ["bankroll", "kelly", "capFrac", "minEdge", "limits.categoryThreshold"];
const L3 = ["limits.l3"];

export function AutonomyView({ data, proposals, settings }: { data: Autonomy; proposals: Proposals; settings: AppSettings }) {
  const router = useRouter();
  const f = useSettingsForm(settings);
  const [err, setErr] = useState<string | null>(null);
  const [killErr, setKillErr] = useState<string | null>(null);
  const [sending, setSending] = useState<Set<string>>(new Set());
  const ex = data.exchangeConfigured;
  const enabled: Mode[] = ex ? ["L0", "L1", "L2", "L3", "L4"] : ["L0", "L1"];

  const setMode = async (to: Mode) => {
    setErr(null);
    const r = await fetch("/api/autonomy/mode", { method: "POST", headers: JSON_H, body: JSON.stringify({ to }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(`Mode change failed: ${j.error ?? r.status}`);
    else if (!j.allowed) setErr(`${to} refused: ${j.reason}`);
    router.refresh();
  };
  const setOverride = async (category: string, override: Mode) => {
    setErr(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: JSON_H, body: JSON.stringify({ overrides: { [category]: override } }) });
    if (!r.ok) setErr(`Override failed: ${r.status}`);
    router.refresh();
  };
  const kill = async () => {
    try {
      const res = await postKill();
      setKillErr(killError(res));
      router.refresh();
      return res;
    } catch (e) { setKillErr((e as Error).message); }
  };
  const decide = async (id: string, action: "approve" | "reject", set = false) => {
    setErr(null);
    setSending((s) => new Set(s).add(id));
    const r = await fetch(`/api/${set ? "sets" : "proposals"}/${id}`, { method: "POST", headers: JSON_H, body: JSON.stringify({ action, via: "web" }) }).catch(() => null);
    if (!r?.ok) setErr(`${action === "approve" ? "Approve" : "Reject"} failed: ${r ? ((await r.json().catch(() => ({}))).error ?? r.status) : "network error"}`);
    router.refresh();
    setSending((s) => { const n = new Set(s); n.delete(id); return n; });
  };
  const ack = async (id: string) => {
    const r = await fetch(`/api/sets/${id}/ack`, { method: "POST" }).catch(() => null);
    router.refresh();
    return r?.ok ? null : `Acknowledge failed: ${r ? ((await r.json().catch(() => ({}))).error ?? r.status) : "network error"}`;
  };
  const pending = proposals.pending.map((p) => (sending.has(p.id) ? { ...p, state: "sending" as const } : p));
  const sets = proposals.sets ?? { pending: [], recent: [] };
  const setsShown = { ...sets, pending: sets.pending.map((s) => (sending.has(s.id) && s.state === "pending" ? { ...s, state: "sending" } : s)) };
  const flagged = sets.recent.filter((s) => s.state === "flagged");

  const nPending = pending.length + sets.pending.length;
  const cats = data.categories.map((c) => c.category);

  return (
    <div className={pg.stack}>
      <div className="page-h"><h1>Autonomy</h1></div>
      <p className={css.lead}>What the system does on its own, and the limits it works inside. Trades you place yourself follow the Paper / Live switch in the header, not this mode.</p>
      {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}
      {f.msg && <ErrorBar message={f.msg} onDismiss={() => f.setMsg(null)} />}
      {killErr && <ErrorBar message={killErr} onRetry={() => void kill()} onDismiss={() => setKillErr(null)} />}
      {flagged.length > 0 && <div id="flagged">{flagged.map((s) => <FlaggedSetBar key={s.id} set={s} onAck={ack} />)}</div>}
      <Panel title="Mode" pad>
        <div className={css.body}>
          <div className={css.now}><ModeBadge mode={data.mode} size="lg" /><span className={css.nowText}>{MODE_HELP[data.mode]}</span></div>
          {nPending > 0 && <p className={css.note}><a href="#approvals">{nPending} trade{nPending === 1 ? "" : "s"} waiting for your approval {"↓"}</a></p>}
          <ModeSelector mode={data.mode} enabledModes={enabled} reasons={{ L2: EX_WHY, L3: EX_WHY, L4: EX_WHY }} onChange={setMode} />
          {!ex && <p className={css.note}>{EX_WHY}</p>}
          <p className={css.note}>An idea qualifies when its edge is at least 2¢ after fees, the judge&apos;s confidence is above the minimum set under Sizing, and the order book is under a minute old. The mode also drops on its own after the daily loss limit, 3 order errors, prices older than 5 min, a balance mismatch or a research outage; the event log says why.</p>
        </div>
      </Panel>
      {f.group("Sizing", SIZING, <>
        {f.num("bankroll", "bankroll B", { unit: "USD", hint: "The money sizing works from. Trade sizes and the % caps scale with it. Example 1,000." })}
        {f.num("kelly", "Kelly fraction", { hint: "Share of the full Kelly bet to use, 0 to 1. 0.25 (quarter Kelly) is a common cautious choice." })}
        {f.num("capFrac", "per-trade cap", { unit: "% of B", scale: 100, hint: "No trade is sized above this share of B. Typical 5." })}
        {f.num("minEdge", "min edge", { unit: "¢", scale: 100, hint: "Edge a trade must keep after fees and price impact; the size shrinks until it does. Typical 2." })}
        {f.num("limits.categoryThreshold", "min judge confidence", { hint: "An idea qualifies only when the judge's confidence (0 to 1) is above this. Typical 0.3." })}
      </>, { intro: "How big each trade is, on paper and live. The watchlist's suggested sizes use the same numbers." })}
      <RiskLimits form={f} usage={data.usage} />
      {f.group("Small-auto caps (L3)", L3, <>
        {f.num("limits.l3.perTradeUsd", "per-trade ceiling", { unit: "USD", hint: "Largest order L3 sends without asking. Typical 25." })}
        {f.num("limits.l3.dailyNotional", "daily auto total", { unit: "USD", hint: "Most L3 sends on its own per day. After that, orders wait for approval. Typical 150." })}
        {f.multi("limits.l3.categoryAllowlist", "allowed categories", cats, "Only these categories send on their own. Empty means none do: every order waits for approval.")}
        {f.check("limits.l3.structuralAuto", "structural sets", "Let L3 send neg-risk sets (every outcome of one event) on its own. Off: sets wait for approval.")}
      </>, { intro: "At L3 an order goes out without you only when it fits all four. Anything else falls back to approval, as in L2.", saveLabel: "Save L3 caps" })}
      <CategoryOverrides rows={data.categories} mode={data.mode} onChange={setOverride} />
      <GatePanel gates={data.gates} />
      <ApprovalsPane mode={data.mode} pending={pending} recent={proposals.recent} sets={setsShown} l3={data.limits.l3} recon={data.recon} onDecide={decide} />
      <Panel title="Kill switch" pad>
        <KillSwitchButton mode={data.mode} liveOpenOrders={data.liveOpenOrders ?? 0} onKill={kill} wide />
        <p className={pg.hint} style={{ margin: "var(--sp-2) 0 0" }}>Drops to L0 Observe and cancels every open live order. Immediate, no undo, logged below. The same button sits in the header on every page.</p>
      </Panel>
      <EventLog events={data.events} />
    </div>
  );
}

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
import { ModeSelector } from "../../../components/ModeSelector";
import { RiskLimits } from "../../../components/RiskLimits";
import { killError, postKill, type Proposal, type Recon, type SetView } from "../../../components/live";
import type { read } from "../../../lib/jobs";
import pg from "../../../components/page.module.css";
import { Panel } from "../../../components/ui";

export type Autonomy = Awaited<ReturnType<typeof read.autonomy>> & { liveOpenOrders?: number; recon?: Recon | null };
type Proposals = { pending: Proposal[]; recent: Proposal[]; sets?: { pending: SetView[]; recent: SetView[] } };
const JSON_H = { "content-type": "application/json" };

const EX_WHY = "L2–L4 need a configured exchange (PM_PRIVATE_KEY on the server).";

export function AutonomyView({ data, proposals }: { data: Autonomy; proposals: Proposals }) {
  const router = useRouter();
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

  return (
    <div className={pg.stack}>
      <div className="page-h">
        <h1>Autonomy</h1>
        <div className="r">
          <ModeSelector mode={data.mode} enabledModes={enabled} reasons={{ L2: EX_WHY, L3: EX_WHY, L4: EX_WHY }} onChange={setMode} />
        </div>
      </div>
      {!ex && <p className={pg.hint} style={{ marginTop: "calc(-1 * var(--sp-2))" }}>{EX_WHY}</p>}
      {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}
      {killErr && <ErrorBar message={killErr} onRetry={() => void kill()} onDismiss={() => setKillErr(null)} />}
      {flagged.length > 0 && <div id="flagged">{flagged.map((s) => <FlaggedSetBar key={s.id} set={s} onAck={ack} />)}</div>}
      <ApprovalsPane mode={data.mode} pending={pending} recent={proposals.recent} sets={setsShown} l3={data.limits.l3} recon={data.recon} onDecide={decide} />
      <CategoryOverrides rows={data.categories} mode={data.mode} onChange={setOverride} />
      <RiskLimits limits={data.limits} usage={data.usage} />
      <GatePanel gates={data.gates} />
      <Panel title="Kill switch" pad>
        <KillSwitchButton mode={data.mode} liveOpenOrders={data.liveOpenOrders ?? 0} onKill={kill} wide />
        <p className={pg.hint} style={{ margin: "var(--sp-2) 0 0" }}>Drops to L0 and cancels all open orders. Immediate. No undo. Logged to autonomy_events.</p>
      </Panel>
      <EventLog events={data.events} />
    </div>
  );
}

"use client";
import type { Mode } from "@pm/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CategoryOverrides } from "../../../components/CategoryOverrides";
import { EventLog } from "../../../components/EventLog";
import { GatePanel } from "../../../components/GatePanel";
import { KillSwitchButton } from "../../../components/KillSwitchButton";
import { ModeSelector } from "../../../components/ModeSelector";
import { RiskLimits } from "../../../components/RiskLimits";
import type { read } from "../../../lib/jobs";
import css from "../../../components/panels.module.css";

export type Autonomy = Awaited<ReturnType<typeof read.autonomy>>;
const JSON_H = { "content-type": "application/json" };

export function AutonomyView({ data }: { data: Autonomy }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const enabled: Mode[] = data.executionEnabled ? ["L0", "L1", "L2", "L3", "L4"] : ["L0", "L1"];

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
  const kill = async () => { await fetch("/api/autonomy/kill", { method: "POST" }); router.refresh(); };

  return (
    <div className={css.stack}>
      <section className="pane">
        <h2>Mode</h2>
        <ModeSelector mode={data.mode} enabledModes={enabled} disabledReason="Execution ships in phase 6" onChange={setMode} />
        {err && <p className={`neg ${css.line}`} role="alert" style={{ margin: 0 }}>{err}</p>}
      </section>
      <CategoryOverrides rows={data.categories} mode={data.mode} onChange={setOverride} />
      <RiskLimits limits={data.limits} usage={data.usage} />
      <GatePanel gates={data.gates} />
      <section>
        <KillSwitchButton mode={data.mode} onKill={kill} wide />
        <p className="muted ui" style={{ margin: "var(--sp-1) 0 0" }}>Drops to L0 and cancels all open orders. Immediate. No undo. Logged to autonomy_events.</p>
      </section>
      <EventLog events={data.events} />
    </div>
  );
}

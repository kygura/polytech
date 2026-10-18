"use client";
import { DEFAULT_STEERING, type Steering } from "@pm/core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Drawer } from "./Drawer";
import { Field } from "./Field";
import { truncate } from "./fmt";
import { SteeringForm } from "./research/SteeringForm";
import { mapIssues, scope, steeringDiff } from "./research/steering";
import ui from "./ui.module.css";
import cx from "../app/(app)/research/research.module.css";

export type SteerProfile = { id: string; name: string; steering: Steering };
type Phase = "idle" | "launching" | "started" | "error";
const clone = (s: Steering) => structuredClone(s);

/** Ad-hoc steered run: pick a profile, tweak, send only the overrides to POST /api/markets/:id/research. */
export function SteerDrawer({ conditionId, question, profiles, models, open, onClose }: {
  conditionId: string; question: string; profiles: SteerProfile[]; models: readonly string[]; open: boolean; onClose: () => void;
}) {
  const router = useRouter();
  const [profileId, setProfileId] = useState("");
  const base = profiles.find((p) => p.id === profileId)?.steering ?? DEFAULT_STEERING;
  const [steering, setSteering] = useState(() => clone(DEFAULT_STEERING));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<{ tone: "pos" | "warn" | "neg" | "muted"; text: string } | null>(null);

  useEffect(() => { if (open) { setProfileId(""); setSteering(clone(DEFAULT_STEERING)); setErrors({}); setPhase("idle"); setMsg(null); } }, [open]);

  const pick = (id: string) => {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    setSteering(clone(p?.steering ?? DEFAULT_STEERING));
    setErrors({});
    setMsg(p ? { tone: "muted", text: `fields reset to ${p.name}` } : null);
  };

  const submit = async () => {
    if (phase === "launching" || phase === "started") return;
    setPhase("launching"); setMsg(null); setErrors({});
    const diff = steeringDiff(base, steering), has = Object.keys(diff).length > 0;
    const body = { ...(profileId && { profileId }), ...(has && { steering: diff }) };
    try {
      const r = await fetch(`/api/markets/${conditionId}/research`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.status === 202) {
        setPhase("started"); setMsg({ tone: "pos", text: "Started — pod queued" });
        setTimeout(() => { onClose(); router.refresh(); }, 800);
        return;
      }
      setPhase("error");
      if (r.status === 400 && j?.issues) {
        const e = mapIssues(j.issues);
        setErrors({ ...e, ...scope(e, "steering.") });
        if (e[""]) setMsg({ tone: "neg", text: e[""] });
      } else if (r.status === 404) setMsg({ tone: "neg", text: "Market or profile not found." });
      else setMsg({ tone: "neg", text: `Failed: ${j?.error ?? r.status}` });
    } catch { setPhase("error"); setMsg({ tone: "neg", text: "Failed: network error" }); }
  };

  const busy = phase === "launching" || phase === "started";
  return (
    <Drawer open={open} title={`Research · ${truncate(question, 48)}`} onClose={onClose}>
      <div onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }}>
        <div className={ui.grid2} style={{ padding: 0 }}>
          <Field label="profile" htmlFor="sd-profile">
            <select id="sd-profile" value={profileId} disabled={busy} onChange={(e) => pick(e.target.value)}>
              <option value="">Default</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <SteeringForm idp="sd" compact disabled={busy} value={steering} onChange={setSteering} errors={errors} models={models} customPool={base.customRoles} />
        </div>
        <div className={cx.tools} style={{ marginTop: "var(--sp-3)" }}>
          <button type="button" className={cx.primary} onClick={submit} disabled={busy || (steering.question?.length ?? 0) > 2000 || steering.roles.length < 1}>
            {phase === "launching" ? "Starting…" : "Start research"}<span className={cx.hint}>Ctrl+Enter</span>
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
          {phase === "error" && msg?.text.startsWith("Failed") && <button type="button" onClick={submit}>Retry</button>}
        </div>
        <p className={msg?.tone} role="status" style={{ minHeight: "1.5em" }}>{msg?.text}</p>
      </div>
    </Drawer>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inInput } from "../hooks/useGlobalKeys";
import { ResearchRunning } from "./ResearchRunning";
import { SteerDrawer, type SteerProfile } from "./SteerDrawer";
import css from "./detail.module.css";

type Props = { conditionId: string; pinned: boolean; muted: boolean; running: { startedAt: number } | null; now: number; question: string; profiles: SteerProfile[]; models: readonly string[]; researchDisabled: boolean };

/** Re-research (r, one click), Steer… (s, drawer), Pin (p), Mute (m). Mutations go through /api; the page re-renders via router.refresh. */
export function ActionBar({ conditionId, pinned, muted, running, now, question, profiles, models, researchDisabled }: Props) {
  const router = useRouter();
  const [steer, setSteer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const off = researchDisabled ? "Research is disabled on this server" : undefined;
  const base = `/api/markets/${conditionId}`;

  const flag = async (body: { pinned?: boolean; muted?: boolean }) => {
    await fetch(`${base}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    router.refresh();
  };
  const research = async () => {
    if (busy || running || researchDisabled) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${base}/research`, { method: "POST" });
      if (!r.ok) setErr((await r.json().catch(() => null))?.error ?? `research failed: ${r.status}`);
    } catch { setErr("research failed: network error"); } finally { setBusy(false); router.refresh(); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "r") research();
      else if (e.key === "s" && !running && !researchDisabled) setSteer(true);
      else if (e.key === "p") flag({ pinned: !pinned });
      else if (e.key === "m") flag({ muted: !muted });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className={css.actions} role="toolbar" aria-label="market actions">
      <button type="button" onClick={research} disabled={busy || !!running || researchDisabled} title={off} aria-label="re-research this market (r)">Re-research<span className={css.key}>r</span></button>
      <button type="button" onClick={() => setSteer(true)} disabled={busy || !!running || researchDisabled} title={off} aria-label="steer and research this market (s)">Steer…<span className={css.key}>s</span></button>
      <button type="button" onClick={() => flag({ pinned: !pinned })} aria-pressed={pinned} aria-label={`${pinned ? "unpin" : "pin"} (p)`}>{pinned ? "Unpin" : "Pin"}<span className={css.key}>p</span></button>
      <button type="button" onClick={() => flag({ muted: !muted })} aria-pressed={muted} aria-label={`${muted ? "unmute" : "mute"} (m)`}>{muted ? "Unmute" : "Mute"}<span className={css.key}>m</span></button>
      {err && <span className="neg ui" role="alert">{err}</span>}
      {(running || busy) && <ResearchRunning elapsedS={running ? (now - running.startedAt) / 1000 : undefined} />}
      <SteerDrawer conditionId={conditionId} question={question} profiles={profiles} models={models} open={steer} onClose={() => setSteer(false)} />
    </div>
  );
}

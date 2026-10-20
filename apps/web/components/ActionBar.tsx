"use client";
import { useEffect, useState } from "react";
import { inInput } from "../hooks/useGlobalKeys";
import { Button } from "./ui";
import { ResearchRunning } from "./ResearchRunning";
import { SteerDrawer, type SteerProfile } from "./SteerDrawer";
import { ALLOWED_MODELS } from "@pm/core";
import css from "./detail.module.css";

type Props = { conditionId: string; pinned: boolean; muted: boolean; running: { startedAt: number } | null; question: string; researchDisabled: boolean; onChanged: () => void };

/** POST /api/markets/:id/research: null on success, else the reason (also the Research tab's empty-state button). */
export async function startResearch(conditionId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/markets/${conditionId}/research`, { method: "POST" });
    return r.ok ? null : (await r.json().catch(() => null))?.error ?? `research failed: ${r.status}`;
  } catch { return "research failed: network error"; }
}

/** Research (r, one click), Steer… (⇧S, drawer), Pin (p), Mute (m). Mutations go through /api; `onChanged` refetches the page's market data. */
export function ActionBar({ conditionId, pinned: pinnedProp, muted: mutedProp, running, question, researchDisabled, onChanged }: Props) {
  // The detail refetch can take a second or two: show the new flag at once, drop the guess when the server's value arrives.
  const [guess, setGuess] = useState<{ pinned?: boolean; muted?: boolean }>({});
  useEffect(() => setGuess({}), [pinnedProp, mutedProp, conditionId]);
  const pinned = guess.pinned ?? pinnedProp, muted = guess.muted ?? mutedProp;
  const [steer, setSteer] = useState(false);
  const [profiles, setProfiles] = useState<SteerProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const off = researchDisabled ? "Research is disabled on this server" : undefined;
  const base = `/api/markets/${conditionId}`;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  // Profiles for the steer drawer load when it first opens.
  useEffect(() => {
    if (!steer) return;
    fetch("/api/research/profiles").then((r) => (r.ok ? r.json() : [])).then((p: { id: string; name: string; steering: SteerProfile["steering"] }[]) => setProfiles(p.map((x) => ({ id: x.id, name: x.name, steering: x.steering })))).catch(() => {});
  }, [steer]);

  const flag = async (body: { pinned?: boolean; muted?: boolean }) => {
    setGuess((g) => ({ ...g, ...body }));
    const r = await fetch(`${base}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!r?.ok) setGuess({});
    onChanged();
  };
  const research = async () => {
    if (busy || running || researchDisabled) return;
    setBusy(true);
    setErr(await startResearch(conditionId));
    setBusy(false);
    onChanged();
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "S" && !running && !researchDisabled) { e.preventDefault(); setSteer(true); }
      else if (e.shiftKey) return;
      else if (e.key === "r") void research();
      else if (e.key === "p") void flag({ pinned: !pinned });
      else if (e.key === "m") void flag({ muted: !muted });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const lock = busy || !!running || researchDisabled;
  return (
    <div className={css.actions} role="toolbar" aria-label="market actions">
      <Button variant="ghost" size="sm" onClick={research} disabled={lock} title={off ?? "Re-research this market (r)"}>Research<kbd>r</kbd></Button>
      <Button variant="ghost" size="sm" onClick={() => setSteer(true)} disabled={lock} title={off ?? "Steer and research this market (Shift S)"}>Steer{"…"}<kbd>{"⇧S"}</kbd></Button>
      <Button variant="ghost" size="sm" onClick={() => void flag({ pinned: !pinned })} aria-pressed={pinned} title={`${pinned ? "Unpin" : "Pin"} (p)`}>
        {pinned && <span className={css.pinDot} aria-hidden />}{pinned ? "Unpin" : "Pin"}<kbd>p</kbd>
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void flag({ muted: !muted })} aria-pressed={muted} title={`${muted ? "Unmute" : "Mute"} (m)`}>{muted ? "Unmute" : "Mute"}<kbd>m</kbd></Button>
      {err && <span className="down" role="alert">{err}</span>}
      {(running || busy) && <ResearchRunning elapsedS={running ? Math.max(0, (now - running.startedAt) / 1000) : undefined} />}
      <SteerDrawer conditionId={conditionId} question={question} profiles={profiles} models={ALLOWED_MODELS} open={steer} onClose={() => { setSteer(false); onChanged(); }} />
    </div>
  );
}

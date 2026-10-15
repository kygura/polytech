"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inInput } from "../hooks/useGlobalKeys";
import { ResearchRunning } from "./ResearchRunning";
import css from "./detail.module.css";

type Props = { conditionId: string; pinned: boolean; muted: boolean; running: { startedAt: number } | null; now: number };

/** Re-research (r), Pin (p), Mute (m). Mutations go through /api; the page re-renders via router.refresh. */
export function ActionBar({ conditionId, pinned, muted, running, now }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const base = `/api/markets/${conditionId}`;

  const flag = async (body: { pinned?: boolean; muted?: boolean }) => {
    await fetch(`${base}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    router.refresh();
  };
  const research = async () => {
    if (busy || running) return;
    setBusy(true);
    try { await fetch(`${base}/research`, { method: "POST" }); } finally { setBusy(false); router.refresh(); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (inInput(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "r") research();
      else if (e.key === "p") flag({ pinned: !pinned });
      else if (e.key === "m") flag({ muted: !muted });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className={css.actions} role="toolbar" aria-label="market actions">
      <button type="button" onClick={research} disabled={busy || !!running} aria-label="re-research this market (r)">Re-research<span className={css.key}>r</span></button>
      <button type="button" onClick={() => flag({ pinned: !pinned })} aria-pressed={pinned} aria-label={`${pinned ? "unpin" : "pin"} (p)`}>{pinned ? "Unpin" : "Pin"}<span className={css.key}>p</span></button>
      <button type="button" onClick={() => flag({ muted: !muted })} aria-pressed={muted} aria-label={`${muted ? "unmute" : "mute"} (m)`}>{muted ? "Unmute" : "Mute"}<span className={css.key}>m</span></button>
      {(running || busy) && <ResearchRunning elapsedS={running ? (now - running.startedAt) / 1000 : undefined} />}
    </div>
  );
}

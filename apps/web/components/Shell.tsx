"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SHORTCUTS, useGlobalKeys } from "../hooks/useGlobalKeys";
import { useSse, type SseEvent } from "../hooks/useSse";
import { ErrorBar } from "./ErrorBar";
import { useTheme } from "../hooks/useTheme";
import { KillSwitchButton } from "./KillSwitchButton";
import { ModeBadge } from "./ModeBadge";
import { SseIndicator } from "./SseIndicator";
import { STALE_MS, StaleBanner } from "./StaleBanner";
import css from "./Shell.module.css";

const NAV = [["/watchlist", "Watchlist"], ["/fleet", "Fleet"], ["/calibration", "Calibration"], ["/paper", "Paper"], ["/autonomy", "Autonomy"], ["/settings", "Settings"]] as const;
const REFRESH_ON = new Set<SseEvent["type"]>(["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.failed", "pod.done", "thesis.created", "paper.fill", "calibration.done"]);

export function Shell({ mode: initialMode, lastSnapshotAt, now, children }: { mode: Mode; lastSnapshotAt: number | null; now: number; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const sheet = useRef<HTMLDialogElement>(null);
  const { toggle } = useTheme();

  // A failed RSC refresh swaps the view for error.tsx; probe the view's API first so a refetch
  // failure shows ErrorBar above the last good data instead (error.tsx stays for first load).
  // ponytail: doubles the read per refresh; drop the probe if views move to client-side fetching.
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  useEffect(() => setRefreshErr(null), [path]);
  const refreshNow = useCallback(async () => {
    const r = await fetch(`/api${location.pathname}${location.search}`).catch(() => null);
    if (r?.ok) { setRefreshErr(null); router.refresh(); }
    else setRefreshErr(`Refresh failed: ${r ? r.status : "network error"} · showing last loaded data`);
  }, [router]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refreshNow, 400);
  }, [refreshNow]);
  const sse = useSse((e) => {
    if (e.type === "mode.changed") setMode(e.payload.to as Mode);
    if (REFRESH_ON.has(e.type)) refresh();
  });
  // Polling fallback while SSE is down.
  useEffect(() => {
    if (sse.status === "live") return;
    const id = setInterval(refreshNow, 30_000);
    return () => clearInterval(id);
  }, [sse.status, refreshNow]);

  useGlobalKeys({
    onHelp: useCallback(() => { const d = sheet.current; if (d) d.open ? d.close() : d.showModal(); }, []),
    onTheme: toggle,
  });

  const kill = async () => {
    const r = await fetch("/api/autonomy/kill", { method: "POST" });
    if (r.ok) { setMode("L0"); router.refresh(); }
  };

  return (
    <>
      <header className={css.header}>
        <Link href="/watchlist" className={css.wordmark}>PM-EDGE</Link>
        <nav className={css.nav} aria-label="main">
          {NAV.map(([href, label]) => <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}>{label}</Link>)}
        </nav>
        <div className={css.right}>
          <button type="button" className={css.themeBtn} onClick={toggle} aria-label="toggle theme (t)" title="toggle theme (t)">theme</button>
          <SseIndicator status={sse.status} lastEventAt={sse.lastEventAt} />
          <ModeBadge mode={mode} size="lg" />
          <KillSwitchButton mode={mode} onKill={kill} />
        </div>
      </header>
      <main className={css.main}>
        {refreshErr && <ErrorBar message={refreshErr} onRetry={refreshNow} />}
        {/* Watchlist renders its own banner (it also mutes its numbers); settings is not a data view. */}
        {lastSnapshotAt != null && now - lastSnapshotAt > STALE_MS && !/^\/(watchlist|settings)/.test(path) && <StaleBanner lastSnapshotAt={lastSnapshotAt} now={now} />}
        {children}
      </main>
      <dialog ref={sheet} className={css.sheet} aria-label="keyboard shortcuts">
        <h2>Shortcuts</h2>
        <table><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><th scope="row">{k}</th><td className="ui muted">{d}</td></tr>)}</tbody></table>
        <p className="muted ui" style={{ margin: "var(--sp-2) 0 0" }}>Esc closes</p>
      </dialog>
    </>
  );
}

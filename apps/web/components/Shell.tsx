"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SHORTCUTS, useGlobalKeys } from "../hooks/useGlobalKeys";
import { useSse, type SseEvent } from "../hooks/useSse";
import { ApprovalsBadge } from "./ApprovalsBadge";
import { ErrorBar } from "./ErrorBar";
import { killError, postKill, type Recon } from "./live";
import { useTheme } from "../hooks/useTheme";
import { KillSwitchButton } from "./KillSwitchButton";
import { ModeBadge } from "./ModeBadge";
import { SseIndicator } from "./SseIndicator";
import { STALE_MS, StaleBanner } from "./StaleBanner";
import css from "./Shell.module.css";

const NAV = [["/watchlist", "Watchlist"], ["/fleet", "Fleet"], ["/calibration", "Calibration"], ["/paper", "Book"], ["/autonomy", "Autonomy"], ["/settings", "Settings"]] as const;
const REFRESH_ON = new Set<SseEvent["type"]>(["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.failed", "pod.done", "thesis.created", "paper.fill", "calibration.done", "proposal.created", "proposal.updated", "order.updated", "order.filled", "order.error", "recon.done"]);
const STATUS_ON = new Set<SseEvent["type"]>(["mode.changed", "proposal.created", "proposal.updated", "order.updated", "recon.done"]);
type Status = { pendingCount?: number; liveOpenOrders?: number; recon?: Recon | null };

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
  // Header status (DESIGN 8.7): pending count, live open orders, recon. Refetched on the events that move it.
  const [status, setStatus] = useState<Status>({});
  const loadStatus = useCallback(() => {
    fetch("/api/autonomy").then((r) => (r.ok ? r.json() : null)).then((j) => j && setStatus(j)).catch(() => {});
  }, []);
  useEffect(loadStatus, [loadStatus]);
  const sse = useSse((e) => {
    if (e.type === "mode.changed") setMode(e.payload.to as Mode);
    if (REFRESH_ON.has(e.type)) refresh();
    if (STATUS_ON.has(e.type)) loadStatus();
  });
  // Polling fallback while SSE is down.
  useEffect(() => {
    if (sse.status === "live") return;
    const id = setInterval(() => { void refreshNow(); loadStatus(); }, 30_000);
    return () => clearInterval(id);
  }, [sse.status, refreshNow, loadStatus]);

  useGlobalKeys({
    onHelp: useCallback(() => { const d = sheet.current; if (d) d.open ? d.close() : d.showModal(); }, []),
    onTheme: toggle,
  });

  const [killErr, setKillErr] = useState<string | null>(null);
  const kill = async () => {
    try {
      const res = await postKill();
      setMode("L0");
      setKillErr(killError(res));
      loadStatus();
      router.refresh();
      return res;
    } catch (e) { setKillErr((e as Error).message); }
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
          <ApprovalsBadge pendingCount={status.pendingCount ?? 0} recon={status.recon} />
          <KillSwitchButton mode={mode} liveOpenOrders={status.liveOpenOrders ?? 0} onKill={kill} />
        </div>
      </header>
      <main className={css.main}>
        {killErr && <ErrorBar message={killErr} onRetry={() => void kill()} onDismiss={() => setKillErr(null)} />}
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

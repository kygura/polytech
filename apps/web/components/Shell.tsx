"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { shortcutsFor, useGlobalKeys } from "../hooks/useGlobalKeys";
import { useOpStatus } from "../hooks/useOpStatus";
import { useSse, type SseEvent } from "../hooks/useSse";
import { AlertsDrawer } from "./AlertsDrawer";
import { ApprovalsBadge } from "./ApprovalsBadge";
import { ErrorBar } from "./ErrorBar";
import { killError, postKill, type Recon } from "./live";
import { useTheme } from "../hooks/useTheme";
import { KillSwitchButton } from "./KillSwitchButton";
import { MarketSearch } from "./MarketSearch";
import { ModeBadge } from "./ModeBadge";
import { STALE_MS, StaleBanner } from "./StaleBanner";
import { StatusBar } from "./StatusBar";
import css from "./Shell.module.css";

// DESIGN 12.1.2: label, href, `g` chord. Trade leaves the operator shell (route group change): a plain <a>, not a client-side Link.
const NAV = [["Screener", "/markets", "m"], ["Watchlist", "/watchlist", "w"], ["Trade", "/trade", "t"], ["Runs", "/runs", "f"], ["Research", "/research", "r"], ["Journal", "/journal", "j"], ["Book", "/paper", "p"], ["Autonomy", "/autonomy", "a"], ["Settings", "/settings", "s"]] as const;
// Views whose GET lives under another name; the refresh probe must hit the real one.
const PROBE: Record<string, string> = { "/runs": "/api/fleet", "/journal": "/api/calibration" };
// Events that move the status bar (DESIGN 12.1.5).
const BAR_ON = new Set<SseEvent["type"]>(["pod.started", "pod.failed", "pod.done", "snapshot.done", "sweep.done", "alert.created", "alert.acked"]);
const REFRESH_ON = new Set<SseEvent["type"]>(["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.failed", "pod.done", "thesis.created", "paper.fill", "calibration.done", "proposal.created", "proposal.updated", "order.updated", "order.filled", "order.error", "recon.done", "set.updated"]);
const STATUS_ON = new Set<SseEvent["type"]>(["mode.changed", "proposal.created", "proposal.updated", "order.updated", "recon.done", "set.updated"]);
type Status = { pendingCount?: number; flaggedSets?: number; liveOpenOrders?: number; recon?: Recon | null };

export function Shell({ mode: initialMode, lastSnapshotAt, now, children }: { mode: Mode; lastSnapshotAt: number | null; now: number; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const sheet = useRef<HTMLDialogElement>(null);
  const { toggle } = useTheme();
  const [finding, setFinding] = useState(false);
  const findBtn = useRef<HTMLButtonElement>(null);

  // A failed RSC refresh swaps the view for error.tsx; probe the view's API first so a refetch
  // failure shows ErrorBar above the last good data instead (error.tsx stays for first load).
  // ponytail: doubles the read per refresh; drop the probe if views move to client-side fetching.
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  useEffect(() => setRefreshErr(null), [path]);
  const refreshNow = useCallback(async () => {
    // /research has no GET of its own; probe the profile list it renders.
    const root = "/" + location.pathname.split("/")[1];
    const r = await fetch(root === "/research" ? "/api/research/profiles" : PROBE[location.pathname] ?? `/api${location.pathname}${location.search}`).catch(() => null);
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
  const bar = useOpStatus(); // status bar + nav counts; polls every 30 s
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsTick, setAlertsTick] = useState(0);
  const sse = useSse((e) => {
    if (e.type === "mode.changed") setMode(e.payload.to as Mode);
    if (REFRESH_ON.has(e.type)) refresh();
    if (STATUS_ON.has(e.type)) loadStatus();
    if (BAR_ON.has(e.type)) bar.reload();
    if (e.type === "alert.created" || e.type === "alert.acked") setAlertsTick((n) => n + 1);
  });
  // Polling fallback while SSE is down.
  useEffect(() => {
    if (sse.status === "live") return;
    const id = setInterval(() => { void refreshNow(); loadStatus(); }, 30_000);
    return () => clearInterval(id);
  }, [sse.status, refreshNow, loadStatus]);

  const [chord, setChord] = useState(false);
  const toggleAlerts = useCallback(() => setAlertsOpen((o) => !o), []);
  const closeAlerts = useCallback(() => setAlertsOpen(false), []);
  useGlobalKeys({
    onHelp: useCallback(() => { const d = sheet.current; if (d) d.open ? d.close() : d.showModal(); }, []),
    onTheme: toggle,
    onSearch: useCallback(() => setFinding(true), []),
    onAlerts: toggleAlerts,
    onPending: setChord,
  });
  const count = (label: string, n: number | undefined) => (n ? <sup className={css.count} title={`${n} ${label}`}>{n}</sup> : null);

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
        <Link href="/watchlist" className={css.wordmark}>PM<i>/</i>EDGE</Link>
        <nav className={css.nav} aria-label="main">
          {NAV.map(([label, href, key]) => {
            const n = label === "Runs" ? count("live runs", bar.status?.runs) : label === "Watchlist" ? count("unacked alerts", bar.status?.unacked) : null;
            const inner = <>{label}{n}<kbd aria-hidden>g {key}</kbd></>;
            return href === "/trade"
              ? <a key={href} href={href}>{inner}</a>
              : <Link key={href} href={href} aria-current={path === href || path.startsWith(href + "/") ? "page" : undefined}>{inner}</Link>;
          })}
        </nav>
        <div className={css.right}>
          <button type="button" ref={findBtn} className={css.themeBtn} onClick={() => setFinding(true)} aria-label="find a market (/)" title="find a market (/)">find market</button>
          <button type="button" className={css.themeBtn} onClick={toggle} aria-label="toggle theme (t)" title="toggle theme (t)">theme</button>
          <ModeBadge mode={mode} size="lg" />
          <ApprovalsBadge pendingCount={status.pendingCount ?? 0} recon={status.recon} flaggedSets={status.flaggedSets ?? 0} />
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
      <StatusBar status={bar.status} sse={sse.status} lastEventAt={sse.lastEventAt} chord={chord} onAlerts={toggleAlerts} />
      <AlertsDrawer open={alertsOpen} onClose={closeAlerts} refreshKey={alertsTick} onUnacked={bar.setUnacked} />
      <MarketSearch open={finding} onClose={() => { setFinding(false); findBtn.current?.focus(); }} />
      <dialog ref={sheet} className={css.sheet} aria-label="keyboard shortcuts">
        <h2>Shortcuts</h2>
        {shortcutsFor(path).map(({ scope, keys }) => (
          <section key={scope} aria-label={scope}>
            <h3>{scope}</h3>
            <table><tbody>{keys.map(([k, d]) => <tr key={k}><th scope="row"><Caps keys={k} /></th><td className="ui muted">{d}</td></tr>)}</tbody></table>
          </section>
        ))}
        <p className="muted ui" style={{ margin: "var(--sp-2) 0 0" }}>Esc closes</p>
      </dialog>
    </>
  );
}

/** "j / k" -> two caps; "g m" -> two caps; " / " separates alternatives. */
function Caps({ keys }: { keys: string }) {
  return <>{keys.split(" / ").map((alt, i) => <Fragment key={alt}>{i > 0 && " / "}{alt.split(" ").map((k, j) => <Fragment key={j}>{j > 0 && " "}<kbd>{k}</kbd></Fragment>)}</Fragment>)}</>;
}

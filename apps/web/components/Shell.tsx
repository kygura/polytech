"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useClob } from "../hooks/useClob";
import { shortcutsFor, useGlobalKeys } from "../hooks/useGlobalKeys";
import { useOpStatus } from "../hooks/useOpStatus";
import { useSse, type SseEvent } from "../hooks/useSse";
import { useWalletConnection, WalletContext } from "../hooks/useWallet";
import { AlertsDrawer } from "./AlertsDrawer";
import { ApprovalsBadge } from "./ApprovalsBadge";
import { rememberList } from "./BackLink";
import { ConnectButton } from "./ConnectButton";
import { ErrorBar } from "./ErrorBar";
import { killError, postKill, type Recon } from "./live";
import { useTheme } from "../hooks/useTheme";
import { KillSwitchButton } from "./KillSwitchButton";
import { MarketSearch } from "./MarketSearch";
import { probeUrl } from "./probe";
import { ModeBadge } from "./ModeBadge";
import { StatusSlotContext } from "./ShellContext";
import { STALE_MS, StaleBanner } from "./StaleBanner";
import { StatusBar } from "./StatusBar";
import css from "./Shell.module.css";

// DESIGN 13.3: label, href, `g` chord. Three groups; the third collapses into "More" under 1280px.
type NavItem = readonly [label: string, href: string, key: string];
const GROUPS: readonly (readonly NavItem[])[] = [
  [["Markets", "/markets", "m"], ["Trade", "/trade", "t"], ["Watchlist", "/watchlist", "w"]],
  [["Research", "/research", "r"], ["Runs", "/runs", "f"], ["Journal", "/journal", "j"]],
  [["Portfolio", "/paper", "p"], ["Autonomy", "/autonomy", "a"], ["Settings", "/settings", "s"]],
];
// Workspace pages (/trade, /trade/[id]) fill the viewport between header and status bar; everything else is a scrolling document.
const isWorkspace = (path: string) => /^\/trade(\/|$)/.test(path);
// Events that move the status bar (DESIGN 12.1.5).
const BAR_ON = new Set<SseEvent["type"]>(["pod.started", "pod.stage", "pod.failed", "pod.done", "pod.cancelled", "snapshot.done", "sweep.done", "alert.created", "alert.acked"]);
const REFRESH_ON = new Set<SseEvent["type"]>(["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.stage", "pod.failed", "pod.done", "pod.cancelled", "thesis.created", "paper.fill", "paper.close", "calibration.done", "proposal.created", "proposal.updated", "order.updated", "order.filled", "order.error", "recon.done", "set.updated"]);
const STATUS_ON = new Set<SseEvent["type"]>(["mode.changed", "proposal.created", "proposal.updated", "order.updated", "recon.done", "set.updated"]);
type Status = { pendingCount?: number; flaggedSets?: number; liveOpenOrders?: number; recon?: Recon | null };

export function Shell({ mode: initialMode, lastSnapshotAt, now, children }: { mode: Mode; lastSnapshotAt: number | null; now: number; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const sheet = useRef<HTMLDialogElement>(null);
  const { toggle } = useTheme();
  const wallet = useWalletConnection(); // the one wallet provider: header button and the /trade ticket read it through useWallet()
  const clob = useClob(wallet.exchange);
  const walletValue = useMemo(() => ({ ...wallet, clob }), [wallet, clob]);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const workspace = isWorkspace(path);
  const [finding, setFinding] = useState(false);
  const findBtn = useRef<HTMLButtonElement>(null);

  // A failed RSC refresh swaps the view for error.tsx; probe the view's API first so a refetch
  // failure shows ErrorBar above the last good data instead (error.tsx stays for first load).
  // ponytail: doubles the read per refresh; drop the probe if views move to client-side fetching.
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  useEffect(() => setRefreshErr(null), [path]);
  useEffect(() => rememberList(path), [path]); // BackLink on a market page returns here
  const refreshNow = useCallback(async () => {
    const url = probeUrl(location.pathname, location.search);
    if (!url) { router.refresh(); return; } // no known GET for this view: nothing to probe
    const r = await fetch(url).catch(() => null);
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
  // The Watchlist alerts tab's "open drawer" link (it has no handle on the shell).
  useEffect(() => { const open = () => setAlertsOpen(true); window.addEventListener("pm:alerts-open", open); return () => window.removeEventListener("pm:alerts-open", open); }, []);
  useGlobalKeys({
    onHelp: useCallback(() => { const d = sheet.current; if (d) d.open ? d.close() : d.showModal(); }, []),
    onTheme: toggle,
    onSearch: useCallback(() => setFinding(true), []),
    onAlerts: toggleAlerts,
    onPending: setChord,
  });
  const count = (label: string, n: number | undefined) => (n ? <sup className={css.count} title={`${n} ${label}`}>{n}</sup> : null);
  // Menus (More, ≡) are <details>: close them on navigation.
  useEffect(() => { document.querySelectorAll("details[data-menu]").forEach((d) => d.removeAttribute("open")); }, [path]);

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

  const link = ([label, href]: NavItem) => {
    const n = label === "Runs" ? count("live runs", bar.status?.runs) : label === "Watchlist" ? count("unacked alerts", bar.status?.unacked) : null;
    return (
      <Link key={href} href={href} aria-current={path === href || path.startsWith(href + "/") ? "page" : undefined}>
        {label}{n}
      </Link>
    );
  };

  return (
    <WalletContext.Provider value={walletValue}>
      <StatusSlotContext.Provider value={slot}>
        <header className={css.header}>
          <Link href="/markets" className={css.wordmark}>PM<i>/</i>EDGE</Link>
          <nav className={css.nav} aria-label="main">
            {GROUPS.map((g, i) => (
              <div key={i} className={`${css.group} ${i === 2 ? css.g3 : ""}`}>{g.map(link)}</div>
            ))}
            <details data-menu className={css.more}>
              <summary>More {"▾"}</summary>
              <div className={css.menuList}>{GROUPS[2]!.map(link)}</div>
            </details>
          </nav>
          <details data-menu className={css.burger}>
            <summary aria-label="menu">{"≡"}</summary>
            <div className={css.menuList}>{GROUPS.flat().map(link)}</div>
          </details>
          <button type="button" ref={findBtn} className={css.search} onClick={() => setFinding(true)} aria-label="Search markets (/)" title="Search markets (/)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" /></svg>
            <span className={css.searchText}>Search<span className={css.searchMore}> markets</span></span>
            <kbd aria-hidden>/</kbd>
          </button>
          <div className={css.right}>
            <button type="button" className={css.themeBtn} onClick={toggle} aria-label="toggle theme (t)" title="toggle theme (t)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" /></svg>
            </button>
            <ModeBadge mode={mode} size="lg" />
            <ApprovalsBadge pendingCount={status.pendingCount ?? 0} recon={status.recon} flaggedSets={status.flaggedSets ?? 0} />
            <ConnectButton />
            <KillSwitchButton mode={mode} liveOpenOrders={status.liveOpenOrders ?? 0} onKill={kill} />
          </div>
        </header>
        <main className={workspace ? `${css.main} ${css.workspace}` : css.main}>
          <div className={workspace ? css.wsInner : css.doc}>
            {killErr && <ErrorBar message={killErr} onRetry={() => void kill()} onDismiss={() => setKillErr(null)} />}
            {refreshErr && <ErrorBar message={refreshErr} onRetry={refreshNow} />}
            {/* Watchlist renders its own banner (it also mutes its numbers); settings is not a data view; the terminal has its own feed badge. */}
            {lastSnapshotAt != null && now - lastSnapshotAt > STALE_MS && !/^\/(watchlist|settings|trade)/.test(path) && <StaleBanner lastSnapshotAt={lastSnapshotAt} now={now} />}
            {children}
          </div>
        </main>
        <StatusBar status={bar.status} sse={sse.status} lastEventAt={sse.lastEventAt} chord={chord} onAlerts={toggleAlerts} slotRef={setSlot} />
        <AlertsDrawer open={alertsOpen} onClose={closeAlerts} refreshKey={alertsTick} onUnacked={bar.setUnacked} />
        <MarketSearch open={finding} onClose={() => { setFinding(false); findBtn.current?.focus(); }} />
        <dialog ref={sheet} className={css.sheet} aria-label="keyboard shortcuts">
          <h2>Shortcuts</h2>
          {shortcutsFor(path).map(({ scope, keys }) => (
            <section key={scope} aria-label={scope}>
              <h3>{scope}</h3>
              <table><tbody>{keys.map(([k, d]) => <tr key={k + d}><th scope="row"><Caps keys={k} /></th><td className="ui muted">{d}</td></tr>)}</tbody></table>
            </section>
          ))}
          <p className="muted ui" style={{ margin: "var(--sp-2) 0 0" }}>Esc closes</p>
        </dialog>
      </StatusSlotContext.Provider>
    </WalletContext.Provider>
  );
}

/** "j / k" -> two caps; "g m" -> two caps; " / " separates alternatives. */
function Caps({ keys }: { keys: string }) {
  return <>{keys.split(" / ").map((alt, i) => <Fragment key={alt}>{i > 0 && " / "}{alt.split(" ").map((k, j) => <Fragment key={j}>{j > 0 && " "}<kbd>{k}</kbd></Fragment>)}</Fragment>)}</>;
}

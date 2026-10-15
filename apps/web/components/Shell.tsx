"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SHORTCUTS, useGlobalKeys } from "../hooks/useGlobalKeys";
import { useSse, type SseEvent } from "../hooks/useSse";
import { useTheme } from "../hooks/useTheme";
import { KillSwitchButton } from "./KillSwitchButton";
import { ModeBadge } from "./ModeBadge";
import { SseIndicator } from "./SseIndicator";
import css from "./Shell.module.css";

const NAV = [["/watchlist", "Watchlist"], ["/fleet", "Fleet"], ["/calibration", "Calibration"], ["/paper", "Paper"], ["/autonomy", "Autonomy"], ["/settings", "Settings"]] as const;
const REFRESH_ON = new Set<SseEvent["type"]>(["sweep.done", "snapshot.done", "screen.done", "pod.started", "pod.failed", "pod.done", "thesis.created", "paper.fill", "calibration.done"]);

export function Shell({ mode: initialMode, children }: { mode: Mode; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const sheet = useRef<HTMLDialogElement>(null);
  const { toggle } = useTheme();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), 400);
  }, [router]);
  const sse = useSse((e) => {
    if (e.type === "mode.changed") setMode(e.payload.to as Mode);
    if (REFRESH_ON.has(e.type)) refresh();
  });
  // Polling fallback while SSE is down.
  useEffect(() => {
    if (sse.status === "live") return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [sse.status, router]);

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
      <main className={css.main}>{children}</main>
      <dialog ref={sheet} className={css.sheet} aria-label="keyboard shortcuts">
        <h2>Shortcuts</h2>
        <table><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><th scope="row">{k}</th><td className="ui muted">{d}</td></tr>)}</tbody></table>
        <p className="muted ui" style={{ margin: "var(--sp-2) 0 0" }}>Esc closes</p>
      </dialog>
    </>
  );
}

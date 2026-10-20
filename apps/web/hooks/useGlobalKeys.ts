"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const inInput = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

/** DESIGN 12.1.3. `g c` stays as an unlisted alias of `g j`; `g n` is not a route (alerts drawer, see `chordTarget`). */
export const GO: Record<string, string> = { m: "/markets", w: "/watchlist", t: "/trade", f: "/runs", r: "/research", j: "/journal", c: "/journal", p: "/paper", a: "/autonomy", s: "/settings" };
export const CHORD_MS = 800;

export type Chord = { path: string } | { alerts: true } | null;
/** What `g <key>` does. `n` toggles the alerts drawer only when the shell has one (`hasAlerts`); a `go` map without `n` never reaches it. */
export function chordTarget(key: string, go: Record<string, string>, hasAlerts: boolean): Chord {
  if (key === "n" && hasAlerts) return { alerts: true };
  const path = go[key];
  return path ? { path } : null;
}

/** True when `/` should focus the view's own filter box instead of opening MarketSearch. */
export const filterInput = () => document.querySelector<HTMLInputElement>("input[data-filter]");

/** g+<key> nav, `/` focus filter or find market, Esc blur, `?` sheet, `t` theme. Ignored while an input is focused. `go` replaces the operator g-map (the /trade shell registers only g w / g a); `canGo` can veto g-navigation; `onAlerts` enables `g n`; `onPending` reports a pending `g` (800 ms). */
export function useGlobalKeys({ onHelp, onTheme, onSearch, onAlerts, onPending, go = GO, canGo = () => true }: { onHelp: () => void; onTheme: () => void; onSearch?: () => void; onAlerts?: () => void; onPending?: (pending: boolean) => void; go?: Record<string, string>; canGo?: () => boolean }) {
  const router = useRouter();
  useEffect(() => {
    let pendingG = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => { if (timer) clearTimeout(timer); timer = undefined; onPending?.(false); };
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return; // modal open (search, shortcuts, drawers): it owns the keyboard; Esc closes it natively
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (inInput(e)) return;
      const g = pendingG && Date.now() - pendingG < CHORD_MS;
      pendingG = 0;
      if (g) {
        settle();
        const c = chordTarget(e.key, go, !!onAlerts);
        if (c) {
          if ("alerts" in c) onAlerts!();
          else if (canGo()) router.push(c.path);
          e.preventDefault();
          return;
        }
      }
      switch (e.key) {
        case "g": pendingG = Date.now(); onPending?.(true); timer = setTimeout(settle, CHORD_MS); break;
        case "/": {
          if (!onSearch) break;
          const f = filterInput();
          if (f) f.focus(); else onSearch();
          e.preventDefault();
          break;
        }
        case "?": onHelp(); break;
        case "t": onTheme(); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); if (timer) clearTimeout(timer); };
  }, [router, onHelp, onTheme, onSearch, onAlerts, onPending, go, canGo]);
}

/** `?` sheet content (DESIGN 12.1.1): grouped by scope, Global first. `path` limits a scope to the views it applies to; `keys` rows are `[key caps, what it does]` (" / " separates alternatives, a space separates chord steps). */
export type ShortcutScope = { scope: string; path?: RegExp; keys: [string, string][] };
export const SHORTCUTS: ShortcutScope[] = [
  { scope: "Global", keys: [
    ["g m", "screener"], ["g w", "watchlist"], ["g t", "trade terminal"], ["g f", "runs (fleet)"], ["g r", "research"], ["g j", "journal"],
    ["g p", "book"], ["g a", "autonomy"], ["g s", "settings"], ["g n", "alerts drawer"],
    ["/", "focus the view's filter, else find a market"], ["Esc", "blur / close"], ["t", "toggle theme"], ["?", "this sheet"],
  ] },
  { scope: "Lists", keys: [["j / k", "move selection"], ["Enter", "open row"]] },
  { scope: "Alerts drawer", keys: [["j / k", "move selection"], ["Enter", "ack and open"], ["a", "ack selected"], ["A", "ack all"], ["g n", "close"]] },
  { scope: "Market page", path: /^\/markets\/[^/]/, keys: [["p / m / r / s", "pin / mute / re-research / steer & research"]] },
  { scope: "Research", path: /^\/research/, keys: [["n / p / x", "new / preview / run now"]] },
];
export const shortcutsFor = (path: string) => SHORTCUTS.filter((s) => !s.path || s.path.test(path));

"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const inInput = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

/** DESIGN 13.7. `g u` is an alias of `g f` (Runs); `g n` is not a route (alerts drawer, see `chordTarget`). */
export const GO: Record<string, string> = { m: "/markets", t: "/trade", w: "/watchlist", r: "/research", f: "/runs", u: "/runs", j: "/journal", p: "/paper", a: "/autonomy", s: "/settings" };
export const CHORD_MS = 800;

export type Chord = { path: string } | { alerts: true } | null;
/** What `g <key>` does. `n` toggles the alerts drawer only when the shell has one (`hasAlerts`). */
export function chordTarget(key: string, hasAlerts: boolean): Chord {
  if (key === "n" && hasAlerts) return { alerts: true };
  const path = GO[key];
  return path ? { path } : null;
}

/** True when `/` should focus the view's own filter box instead of opening MarketSearch. */
export const filterInput = () => document.querySelector<HTMLInputElement>("input[data-filter]");

// A `g` waiting for its second key. Module state so page-scope handlers (the /trade single keys) can ignore the key that completes a chord, whatever order the window listeners run in.
let pendingG = 0;
export const chordPending = () => pendingG > 0 && Date.now() - pendingG < CHORD_MS;

/** g+<key> nav, `/` focus the view's filter or open market search, Esc blur, `?` sheet, `t` theme. Ignored while an input is focused or a dialog is open. `onAlerts` enables `g n`; `onPending` reports a pending `g` (800 ms). */
export function useGlobalKeys({ onHelp, onTheme, onSearch, onAlerts, onPending }: { onHelp: () => void; onTheme: () => void; onSearch?: () => void; onAlerts?: () => void; onPending?: (pending: boolean) => void }) {
  const router = useRouter();
  useEffect(() => {
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
      const g = chordPending();
      pendingG = 0;
      if (g) {
        settle();
        const c = chordTarget(e.key, !!onAlerts);
        if (c) {
          if ("alerts" in c) onAlerts!();
          else router.push(c.path);
          e.preventDefault();
          return;
        }
      }
      switch (e.key) {
        case "g": pendingG = Date.now(); onPending?.(true); timer = setTimeout(settle, CHORD_MS); break;
        case "/": {
          if (!onSearch) break;
          const f = filterInput();
          f?.focus();
          if (document.activeElement !== f) onSearch(); // no filter on this view, or it is hidden (the /trade list drawer): find a market
          e.preventDefault();
          break;
        }
        case "?": onHelp(); break;
        case "t": onTheme(); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); if (timer) clearTimeout(timer); };
  }, [router, onHelp, onTheme, onSearch, onAlerts, onPending]);
}

/** `?` sheet content (DESIGN 12.1.1): grouped by scope, Global first. `path` limits a scope to the views it applies to; `keys` rows are `[key caps, what it does]` (" / " separates alternatives, a space separates chord steps). */
export type ShortcutScope = { scope: string; path?: RegExp; keys: [string, string][] };
export const SHORTCUTS: ShortcutScope[] = [
  { scope: "Global", keys: [
    ["g m", "markets"], ["g t", "trade"], ["g w", "watchlist"], ["g r", "research"], ["g f", "runs (fleet)"], ["g j", "journal"],
    ["g p", "portfolio"], ["g a", "autonomy"], ["g s", "settings"], ["g n", "alerts drawer"],
    ["/", "focus the view's filter, else search markets"], ["Esc", "blur / close"], ["t", "toggle theme"], ["?", "this sheet"],
  ] },
  { scope: "Lists", keys: [["j / k", "move selection"], ["Enter", "open row"]] },
  { scope: "Alerts drawer", keys: [["j / k", "move selection"], ["Enter", "ack and open"], ["a", "ack selected"], ["A", "ack all"], ["g n", "close"]] },
  { scope: "Trade", path: /^\/trade(\/|$)/, keys: [
    ["j / k", "move the market list cursor"], ["Enter", "select the cursor market"],
    ["b / s", "ticket Buy / Sell, then Limit"], ["y / n", "ticket outcome YES / NO, then Limit"],
    ["↑ / ↓", "in Limit ± 1 tick (Shift ± 10), in Shares ± min order (Shift × 10)"], ["Tab", "next ticket field"],
    ["Enter", "in a ticket field: review; on review: sign and place (⌘Enter / Ctrl+Enter also signs)"],
    ["l", "order book: ↑↓ move, Enter copies the price, Esc back"], ["Shift T", "focus the ticket"],
    ["p / o", "Positions / Open orders"], ["x", "cancel the focused open order, or the ticket's order"],
  ] },
  { scope: "Market page", path: /^\/markets\/[^/]/, keys: [["p / m / r / s", "pin / mute / re-research / steer & research"]] },
  { scope: "Research", path: /^\/research/, keys: [["n / p / x", "new / preview / run now"]] },
];
export const shortcutsFor = (path: string) => SHORTCUTS.filter((s) => !s.path || s.path.test(path));

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
/** True for a key a page handler must skip: the one completing a `g` chord. Covers both listener orders (the Shell ran first and prevented it, or it has not run yet and `g` is still pending). */
export const chordKey = (e: Pick<KeyboardEvent, "defaultPrevented">) => e.defaultPrevented || chordPending();

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
        if (e.key.length === 1) e.preventDefault(); // every printable key that completes a chord (even `g b`) is consumed: page keys bail on defaultPrevented
        if (c) {
          if ("alerts" in c) onAlerts!();
          else router.push(c.path);
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
    ["b / s", "ticket Buy / Sell, then the amount"], ["y / n", "ticket outcome YES / NO, then the amount"],
    ["↑ / ↓", "in Amount ± $1 (Shift ± $10), in Shares ± min order (Shift × 10), in Limit ± 1 price step (Shift ± 10)"], ["Tab", "next ticket field"],
    ["Enter", "in a ticket field: review; on review: place (⌘Enter / Ctrl+Enter also places; live orders are signed in your wallet)"],
    ["v", "Pro view on / off (order book, trades, market stats)"],
    ["l", "order book: ↑↓ move, Enter copies the price to Limit, Esc back (turns Pro view on)"], ["Shift T", "focus the ticket"],
    ["1 2 3 4", "bottom tabs: Research / Positions / Orders / Rules"], ["e", "expand the bottom pane over the chart"],
    ["[ / ]", "chart range back / forward"], ["f", "chart axis: 0–100 / Fit"],
    ["p / m / r", "pin / mute / re-research this market"], ["Shift S", "steer & research"],
    ["x", "cancel the focused open order, or the ticket's order"],
  ] },
  { scope: "Research", path: /^\/research/, keys: [["n / p / x", "new / preview / run now"]] },
];
export const shortcutsFor = (path: string) => SHORTCUTS.filter((s) => !s.path || s.path.test(path));

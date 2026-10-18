"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const inInput = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

const GO: Record<string, string> = { w: "/watchlist", f: "/fleet", r: "/research", c: "/calibration", p: "/paper", a: "/autonomy", s: "/settings" };

/** g+<key> nav, `/` find market, Esc blur, `?` sheet, `t` theme. Ignored while an input is focused. `go` replaces the operator g-map (the /trade shell registers only g w / g a); `canGo` can veto g-navigation. */
export function useGlobalKeys({ onHelp, onTheme, onSearch, go = GO, canGo = () => true }: { onHelp: () => void; onTheme: () => void; onSearch?: () => void; go?: Record<string, string>; canGo?: () => boolean }) {
  const router = useRouter();
  useEffect(() => {
    let pendingG = 0;
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return; // modal open (search, shortcuts, drawers): it owns the keyboard; Esc closes it natively
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (inInput(e)) return;
      const g = pendingG && Date.now() - pendingG < 800;
      pendingG = 0;
      if (g && go[e.key]) { if (canGo()) router.push(go[e.key]!); e.preventDefault(); return; }
      switch (e.key) {
        case "g": pendingG = Date.now(); break;
        case "/": if (onSearch) { onSearch(); e.preventDefault(); } break;
        case "?": onHelp(); break;
        case "t": onTheme(); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [router, onHelp, onTheme, onSearch, go, canGo]);
}

export const SHORTCUTS: [string, string][] = [
  ["g w / g f / g r / g c / g p / g a / g s", "watchlist / fleet / research / calibration / book / autonomy / settings"],
  ["j / k", "move selection"], ["Enter", "open row"], ["/", "find a market to research"], ["Esc", "blur / close"],
  ["p / m / r / s", "pin / mute / re-research / steer & research (market page)"], ["n / p / x", "research page: new / preview / run now"], ["t", "toggle theme"], ["?", "this sheet"],
];

"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export const inInput = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

const GO: Record<string, string> = { w: "/watchlist", f: "/fleet", c: "/calibration", p: "/paper", a: "/autonomy", s: "/settings" };

/** g+<key> nav, `/` filter, Esc blur, `?` sheet, `t` theme. Ignored while an input is focused. `go` replaces the operator g-map (the /trade shell registers only g w / g a). */
export function useGlobalKeys({ onHelp, onTheme, go = GO }: { onHelp: () => void; onTheme: () => void; go?: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    let pendingG = 0;
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (inInput(e)) return;
      const g = pendingG && Date.now() - pendingG < 800;
      pendingG = 0;
      if (g && go[e.key]) { router.push(go[e.key]!); e.preventDefault(); return; }
      switch (e.key) {
        case "g": pendingG = Date.now(); break;
        case "/": document.querySelector<HTMLInputElement>("[data-filter]")?.focus(); e.preventDefault(); break;
        case "?": onHelp(); break;
        case "t": onTheme(); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [router, onHelp, onTheme, go]);
}

export const SHORTCUTS: [string, string][] = [
  ["g w / g f / g c / g p / g a / g s", "watchlist / fleet / calibration / book / autonomy / settings"],
  ["j / k", "move selection"], ["Enter", "open row"], ["/", "focus filter"], ["Esc", "blur / close"],
  ["p / m / r", "pin / mute / re-research selected"], ["t", "toggle theme"], ["?", "this sheet"],
];

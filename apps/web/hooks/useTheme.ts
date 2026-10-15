"use client";
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";

const apply = (t: Theme) => {
  const light = t === "light" || (t === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
};

/** Stored in localStorage.theme; "system" follows prefers-color-scheme. The root layout applies it before paint. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    try { const t = localStorage.theme; if (t === "light" || t === "dark" || t === "system") setThemeState(t); else setThemeState("system"); } catch {}
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.theme = t; } catch {}
    apply(t);
  }, []);
  const toggle = useCallback(() => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"), [setTheme]);
  return { theme, setTheme, toggle };
}

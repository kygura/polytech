"use client";
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const apply = (t: Theme) => { document.documentElement.dataset.theme = t; };

/** Stored in localStorage.theme; no stored choice = dark. The root layout applies it before paint. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    try { setThemeState(localStorage.theme === "light" ? "light" : "dark"); } catch {}
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.theme = t; } catch {}
    apply(t);
  }, []);
  const toggle = useCallback(() => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"), [setTheme]);
  return { theme, setTheme, toggle };
}

"use client";
import { useCallback, useSyncExternalStore } from "react";

/** paper = orders fill against the live book into the paper book, no wallet; live = real orders from the connected wallet. */
export type TradingMode = "paper" | "live";

const KEY = "pm.trading";
const EVENT = "pm:trading";

let mem: TradingMode = "paper"; // used when storage throws (blocked site data)
const read = (): TradingMode => {
  try { return localStorage.getItem(KEY) === "live" ? "live" : "paper"; } catch { return mem; }
};
const subscribe = (cb: () => void) => {
  const on = (e: Event) => { if (!(e instanceof StorageEvent) || e.key === KEY) cb(); };
  window.addEventListener("storage", on); // other tabs
  window.addEventListener(EVENT, on); // this tab: the header switch and the ticket stay in step
  return () => { window.removeEventListener("storage", on); window.removeEventListener(EVENT, on); };
};

/** Per viewer, stored in localStorage `pm.trading`; nothing stored = paper. Live has to be picked on purpose. */
export function useTradingMode() {
  const mode = useSyncExternalStore(subscribe, read, () => "paper" as const);
  const setMode = useCallback((m: TradingMode) => {
    mem = m;
    try { localStorage.setItem(KEY, m); } catch { /* storage is optional; the choice then lasts until reload */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { mode, setMode, paper: mode === "paper" };
}

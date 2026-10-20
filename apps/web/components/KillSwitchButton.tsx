"use client";
import type { Mode } from "@pm/core";
import { useEffect, useState } from "react";
import { killLabel, type KillResult } from "./live";
import css from "./ui.module.css";

/** One click when no live orders are open. With live orders: click arms a 5 s confirm, second click/Enter fires, Esc aborts (DESIGN 8.3). */
export function KillSwitchButton({ mode, liveOpenOrders = 0, onKill, wide }: { mode: Mode; liveOpenOrders?: number; onKill: () => Promise<KillResult | void> | void; wide?: boolean }) {
  const [killed, setKilled] = useState<KillResult | null | false>(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  const fire = async () => {
    setArmed(false);
    setKilled(null);
    try { setKilled((await onKill()) ?? null); } finally { setTimeout(() => setKilled(false), 3000); }
  };
  const n = liveOpenOrders;
  const label = killed !== false ? killLabel(killed) : armed ? `CONFIRM · CANCEL ${n} LIVE ORDER${n === 1 ? "" : "S"} → L0` : mode === "L0" ? "AT L0 · CANCEL OPEN" : "KILL → L0";
  return (
    <button
      type="button"
      className={`${css.kill} ${wide ? css.killWide : ""}`}
      disabled={killed !== false}
      onClick={() => (n > 0 && !armed ? setArmed(true) : fire())}
      onKeyDown={(e) => { if (e.key === "Escape" && armed) { e.stopPropagation(); setArmed(false); } }}
      aria-label={n > 0
        ? `Kill switch: drop to L0 and cancel ${n} live order${n === 1 ? "" : "s"}${armed ? ", press again to confirm" : ""}`
        : "Kill switch: drop to L0 and cancel all open orders, immediate, no undo"}
    >
      {"■"} {label}
    </button>
  );
}

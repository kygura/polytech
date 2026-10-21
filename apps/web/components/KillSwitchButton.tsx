"use client";
import type { Mode } from "@pm/core";
import { useEffect, useState } from "react";
import { stopLabel } from "./autopilot";
import { killLabel, type KillResult } from "./live";
import css from "./ui.module.css";

/**
 * Stop: autopilot to Off (L0) and cancel the orders the system placed. One click when none are open; with open orders a click arms a 5 s
 * confirm, second click/Enter fires, Esc aborts (DESIGN 8.3). In the header (not `wide`) it hides when there is nothing to stop.
 */
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
  const stop = stopLabel(mode, n, armed);
  if (killed === false && stop == null && !wide) return null;
  const label = killed !== false ? killLabel(killed) : stop ?? "Autopilot is off · nothing to stop";
  return (
    <button
      type="button"
      className={`${css.kill} ${wide ? css.killWide : ""}`}
      disabled={killed !== false}
      onClick={() => (n > 0 && !armed ? setArmed(true) : fire())}
      onKeyDown={(e) => { if (e.key === "Escape" && armed) { e.stopPropagation(); setArmed(false); } }}
      title="Kill switch: turns autopilot off (L0) and cancels every order the system placed. Immediate, no undo. Your own wallet orders on Trade are not touched."
      aria-label={n > 0
        ? `Kill switch: turn autopilot off and cancel ${n} order${n === 1 ? "" : "s"}${armed ? ", press again to confirm" : ""}`
        : "Kill switch: turn autopilot off and cancel all open orders, immediate, no undo"}
    >
      {"■"} {label}
    </button>
  );
}

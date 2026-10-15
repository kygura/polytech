"use client";
import type { Mode } from "@pm/core";
import { useState } from "react";
import css from "./ui.module.css";

/** One click, no confirm. Shows KILLED · L0 for 3 s after firing. */
export function KillSwitchButton({ mode, onKill, wide }: { mode: Mode; onKill: () => Promise<void> | void; wide?: boolean }) {
  const [killed, setKilled] = useState(false);
  const fire = async () => {
    setKilled(true);
    try { await onKill(); } finally { setTimeout(() => setKilled(false), 3000); }
  };
  const label = killed ? "KILLED · L0" : mode === "L0" ? "AT L0 · CANCEL OPEN" : "KILL SWITCH → L0";
  return (
    <button
      type="button"
      className={`${css.kill} ${wide ? css.killWide : ""}`}
      disabled={killed}
      onClick={fire}
      aria-label="Kill switch: drop to L0 and cancel all open orders, immediate, no undo"
    >
      {"■"} {label}
    </button>
  );
}

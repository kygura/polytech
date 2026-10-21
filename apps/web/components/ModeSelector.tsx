"use client";
import { MODES, type Mode } from "@pm/core";
import css from "./autonomy.module.css";

export const MODE_NAME: Record<Mode, string> = { L0: "Observe", L1: "Paper", L2: "Approve each", L3: "Bounded auto", L4: "Full auto" };
/** What the system does on its own in each mode (SPEC "Execution and autonomy modes"). */
export const MODE_HELP: Record<Mode, string> = {
  L0: "Watches markets and researches. Never trades, not even on paper.",
  L1: "Trades every qualifying idea on paper at the real order book. No real money.",
  L2: "Proposes real trades. You approve each one; a proposal expires after 15 min or a 2¢ move.",
  L3: "Sends small real trades on its own inside the L3 caps. Larger ones wait for your approval.",
  L4: "Sends every qualifying real trade on its own, inside all risk limits.",
};

/** One row per mode: name in the mode colour when selected, plus what it does. Click applies at once (SPEC: one action). Disabled rows keep full contrast and say why. */
export function ModeSelector({ mode, enabledModes, reasons, onChange }: { mode: Mode; enabledModes: Mode[]; reasons: Partial<Record<Mode, string>>; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="autonomy mode" className={css.modes}>
      {MODES.map((m) => {
        const n = m.slice(1), en = enabledModes.includes(m), sel = m === mode, why = reasons[m] ?? "";
        return (
          <button key={m} type="button" role="radio" aria-checked={sel} disabled={!en} title={en ? undefined : why} className={css.modeOpt}
            style={sel ? { borderColor: `var(--mode-${n})`, boxShadow: `inset 3px 0 var(--mode-${n})` } : undefined}
            aria-label={`Set mode ${m} ${MODE_NAME[m]}${sel ? " (current)" : ""}: ${MODE_HELP[m]}${en ? "" : ` Disabled: ${why}`}`}
            onClick={() => !sel && onChange(m)}>
            <span className={css.modeName} style={sel ? { color: `var(--mode-${n})` } : undefined}>{m} {MODE_NAME[m]}</span>
            <span className={css.modeDesc}>{MODE_HELP[m]}{!en && <span className="warn"> Unavailable.</span>}</span>
            {sel && <span className={css.modeNow}>current</span>}
          </button>
        );
      })}
    </div>
  );
}

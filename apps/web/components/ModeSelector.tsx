"use client";
import { MODES, type Mode } from "@pm/core";
import ui from "./ui/ui.module.css";

export const MODE_NAME: Record<Mode, string> = { L0: "Observe", L1: "Paper", L2: "Approve each", L3: "Bounded auto", L4: "Full auto" };

/** Segmented radiogroup in the mode colours (DESIGN 13.6). Disabled ones keep the reason in title and aria-label; the caller shows the note line. */
export function ModeSelector({ mode, enabledModes, reasons, onChange }: { mode: Mode; enabledModes: Mode[]; reasons: Partial<Record<Mode, string>>; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="autonomy mode" className={ui.seg}>
      {MODES.map((m) => {
        const n = m.slice(1), en = enabledModes.includes(m), sel = m === mode, why = reasons[m] ?? "";
        return (
          <button key={m} type="button" role="radio" aria-checked={sel} disabled={!en} title={en ? undefined : why}
            // The mode colour marks the selected one only. The rest read in --muted (>= 4.5:1); a disabled one keeps full opacity (the global :disabled .5 would drop it to ~2.5:1) and says why in its title, with the not-allowed cursor.
            style={sel ? { background: `var(--mode-${n})`, color: "var(--on-focus)", boxShadow: "none" } : { color: "var(--muted)", ...(en ? {} : { opacity: 1 }) }}
            aria-label={`Set mode ${m} ${MODE_NAME[m]}${sel ? " (current)" : ""}${en ? "" : `, disabled: ${why}`}`}
            onClick={() => !sel && onChange(m)}>
            {m} {MODE_NAME[m]}
          </button>
        );
      })}
    </div>
  );
}

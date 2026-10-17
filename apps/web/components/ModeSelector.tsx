"use client";
import { MODES, type Mode } from "@pm/core";
import css from "./panels.module.css";

export const MODE_NAME: Record<Mode, string> = { L0: "Observe", L1: "Paper", L2: "Approve each", L3: "Bounded auto", L4: "Full auto" };

/** Five radio-like buttons. Disabled ones keep the reason in title, aria-label and the visible line below. */
export function ModeSelector({ mode, enabledModes, reasons, note, onChange }: { mode: Mode; enabledModes: Mode[]; reasons: Partial<Record<Mode, string>>; note: string | null; onChange: (m: Mode) => void }) {
  return (
    <>
      <div role="radiogroup" aria-label="autonomy mode" className={css.modes}>
        {MODES.map((m) => {
          const n = m.slice(1), en = enabledModes.includes(m), sel = m === mode, why = reasons[m] ?? "";
          return (
            <button key={m} type="button" role="radio" aria-checked={sel} disabled={!en} title={en ? undefined : why} className={css.modeOpt}
              // Disabled and not current: no inline color, so .modeOpt:disabled (faint) applies.
              style={sel ? { borderColor: `var(--mode-${n})`, background: `var(--mode-${n})`, color: "var(--bg)" } : en ? { borderColor: `var(--mode-${n})`, color: `var(--mode-${n})` } : undefined}
              aria-label={`Set mode ${m} ${MODE_NAME[m]}${sel ? " (current)" : ""}${en ? "" : `, disabled: ${why}`}`}
              onClick={() => !sel && onChange(m)}>
              {m} {MODE_NAME[m]}
            </button>
          );
        })}
      </div>
      {note && <p className={`muted ui ${css.line}`} style={{ margin: 0 }}>{note}</p>}
    </>
  );
}

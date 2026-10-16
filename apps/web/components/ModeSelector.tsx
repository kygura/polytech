"use client";
import { MODES, type Mode } from "@pm/core";
import css from "./panels.module.css";

export const MODE_NAME: Record<Mode, string> = { L0: "Observe", L1: "Paper", L2: "Approve each", L3: "Bounded auto", L4: "Full auto" };

/** Five radio-like buttons. Disabled ones keep the reason in title, aria-label and the visible line below. */
export function ModeSelector({ mode, enabledModes, disabledReason, onChange }: { mode: Mode; enabledModes: Mode[]; disabledReason: string; onChange: (m: Mode) => void }) {
  const disabled = MODES.filter((m) => !enabledModes.includes(m));
  return (
    <>
      <div role="radiogroup" aria-label="autonomy mode" className={css.modes}>
        {MODES.map((m) => {
          const n = m.slice(1), en = enabledModes.includes(m), sel = m === mode;
          return (
            <button key={m} type="button" role="radio" aria-checked={sel} disabled={!en} title={en ? undefined : disabledReason} className={css.modeOpt}
              style={{ borderColor: `var(--mode-${n})`, ...(sel ? { background: `var(--mode-${n})`, color: "var(--bg)" } : { color: `var(--mode-${n})` }) }}
              aria-label={`Set mode ${m} ${MODE_NAME[m]}${sel ? " (current)" : ""}${en ? "" : `, disabled: ${disabledReason}`}`}
              onClick={() => !sel && onChange(m)}>
              {m} {MODE_NAME[m]}
            </button>
          );
        })}
      </div>
      {disabled.length > 0 && <p className={`muted ui ${css.line}`} style={{ margin: 0 }}>{disabled[0]}–{disabled[disabled.length - 1]} disabled: {disabledReason}</p>}
    </>
  );
}

"use client";
import type { Mode } from "@pm/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MODES } from "./autopilot";
import css from "./AutopilotChip.module.css";

/**
 * Header chip for the autonomy mode, in words: "Autopilot: Off" … "Autopilot: On". Click opens a short explainer of every level with the
 * current one marked; changing it happens on the Autonomy page, where the gates and limits are.
 */
export function AutopilotChip({ mode }: { mode: Mode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  const cur = MODES[mode];
  return (
    <span ref={box} className={css.wrap}>
      <button ref={btn} type="button" className={css.chip} data-on={mode !== "L0"} style={{ "--c": `var(--mode-${mode.slice(1)})` } as React.CSSProperties}
        aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}
        title={`Autopilot: ${cur.short}. ${cur.help} Click for what each level does.`}>
        <i aria-hidden className={css.dot} /> Autopilot: <b>{cur.short}</b>
      </button>
      {open && (
        <div className={css.pop} role="dialog" aria-label="Autopilot levels">
          <p className={css.lead}>What the system does on its own, without you. Your own trades follow the Paper / Live switch.</p>
          <ol className={css.list}>
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <li key={m} aria-current={m === mode ? "true" : undefined} style={{ "--c": `var(--mode-${m.slice(1)})` } as React.CSSProperties}>
                <span className={css.name}><i aria-hidden className={css.dot} />{MODES[m].short}{m === mode && <span className={css.now}> · now</span>}</span>
                <span className={css.help}>{MODES[m].help}</span>
              </li>
            ))}
          </ol>
          <Link href="/autonomy" className={css.go} onClick={() => setOpen(false)}>Change in Autonomy →</Link>
        </div>
      )}
    </span>
  );
}

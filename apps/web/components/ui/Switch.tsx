import type { ReactNode } from "react";
import css from "./switch.module.css";

/** On/off toggle with a visible label (`role=switch`). `kbd` shows the key that toggles it; `title` explains what it changes. */
export function Switch({ checked, onChange, label, kbd, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; kbd?: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={css.sw} onClick={() => onChange(!checked)} title={title}>
      <span className={css.track} aria-hidden><i /></span>
      <span>{label}</span>
      {kbd && <kbd aria-hidden>{kbd}</kbd>}
    </button>
  );
}

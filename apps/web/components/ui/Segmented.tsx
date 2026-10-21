"use client";
import type { KeyboardEvent } from "react";
import css from "./ui.module.css";

/** Radiogroup of text buttons (DESIGN 13.2): arrows move and select, only the selected one is in the tab order. `outcome` colours a `YES` / `NO` selection with the outcome identity. */
export function Segmented<T extends string>({ label, options, value, onChange, outcome }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void; outcome?: boolean }) {
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = Math.min(options.length - 1, Math.max(0, options.findIndex((o) => o.value === value) + d));
    const group = e.currentTarget;
    onChange(options[n]!.value);
    requestAnimationFrame(() => group.querySelectorAll("button")[n]?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} className={outcome ? `${css.seg} ${css.outcome}` : css.seg} onKeyDown={key}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          className={outcome ? (o.value === "YES" ? css.yesOpt : o.value === "NO" ? css.noOpt : undefined) : undefined} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

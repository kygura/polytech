"use client";
import type { KeyboardEvent } from "react";
import css from "./ui.module.css";

export type TabItem = { id: string; label: string; count?: number; kbd?: string };

/** Roving-tabindex tablist (DESIGN 13.2): arrows move and select, Home/End jump. `panelId` is the id of the tabpanel the strip controls (aria-controls). */
export function Tabs({ items, active, onChange, panelId, label = "tabs" }: { items: TabItem[]; active: string; onChange: (id: string) => void; panelId?: string; label?: string }) {
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.id === active);
    const n = e.key === "ArrowRight" ? Math.min(items.length - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    const strip = e.currentTarget;
    onChange(items[n]!.id);
    requestAnimationFrame(() => strip.querySelectorAll<HTMLElement>('[role="tab"]')[n]?.focus());
  };
  return (
    <div className={css.tabs} role="tablist" aria-label={label} onKeyDown={key}>
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" id={panelId ? `${panelId}-tab-${t.id}` : undefined} aria-selected={t.id === active} aria-controls={panelId} tabIndex={t.id === active ? 0 : -1} className={css.tab} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className={css.tabCount}>{t.count}</span>}
          {t.kbd && <kbd aria-hidden>{t.kbd}</kbd>}
        </button>
      ))}
    </div>
  );
}

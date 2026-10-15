import css from "./ui.module.css";

export type TabItem = { id: string; label: string; count?: number };

export function Tabs({ items, active, onChange }: { items: TabItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className={css.tabs} role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={css.tab} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className={css.count}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

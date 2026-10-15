import css from "./ui.module.css";

/** `data-filter` is what the global `/` key focuses (see useGlobalKeys). */
export function FilterInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="search"
      className={css.filter}
      data-filter
      value={value}
      placeholder={placeholder}
      aria-label="filter"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
    />
  );
}

import css from "./ui.module.css";

export function Skeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={css.skelRow}><span style={{ width: `${55 + ((i * 17) % 40)}%` }} /></div>
      ))}
    </div>
  );
}

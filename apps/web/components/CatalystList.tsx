import css from "./detail.module.css";

/** Items are "YYYY-MM-DD label". */
export function CatalystList({ items, now }: { items: string[]; now: number }) {
  const rows = items.map((c) => ({ date: c.slice(0, 10), label: c.slice(11) || c, ts: Date.parse(c.slice(0, 10)) })).sort((a, b) => a.ts - b.ts);
  return (
    <section className="pane">
      <h2>Catalysts</h2>
      {rows.length ? (
        <ul className={css.list}>
          {rows.map((r, i) => {
            const days = Math.round((r.ts - now) / 86_400_000), past = r.ts < now - 86_400_000;
            return (
              <li key={i} className={`${css.cat} ${past ? "muted" : ""}`}>
                <span>{r.date.slice(5)}</span><span className="ui">{r.label}</span>
                <span>{Number.isNaN(days) ? "—" : past ? "passed" : `in ${Math.max(0, days)} d`}</span>
              </li>
            );
          })}
        </ul>
      ) : <p className={`muted ${css.prose}`}>None</p>}
    </section>
  );
}

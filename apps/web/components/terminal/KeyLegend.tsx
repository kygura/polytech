import css from "./terminal.module.css";

const KEYS: [string[], string][] = [
  [["/"], "search"], [["J", "K"], "market"], [["B", "S"], "buy/sell"], [["Y", "N"], "outcome"], [["↑", "↓"], "tick"], [["⇧↑↓"], "10 ticks"],
  [["Tab"], "next field"], [["⏎"], "review"], [["⌘⏎"], "sign"], [["L"], "ladder"], [["X"], "cancel"], [["Esc"], "back"], [["?"], "all keys"],
];

export function KeyLegend() {
  return (
    <div className={css.legend} aria-label="keyboard shortcuts">
      {KEYS.map(([ks, label]) => <span key={label}>{ks.map((k) => <kbd key={k}>{k}</kbd>)}{label}</span>)}
      <span className={css.r}>feed 3 s · book 15 levels</span>
    </div>
  );
}

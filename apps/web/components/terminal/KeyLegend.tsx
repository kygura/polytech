import css from "./terminal.module.css";

// The first six DESIGN 11.5 keys; the rest are on the `?` sheet. Rendered in the status bar on /trade.
const KEYS: [string[], string][] = [
  [["/"], "search"], [["J", "K"], "market"], [["B", "S"], "buy/sell"], [["Y", "N"], "outcome"], [["↑", "↓"], "tick"], [["⏎"], "review"],
];

export function KeyLegend() {
  return (
    <div className={css.legend} aria-label="keyboard shortcuts">
      {KEYS.map(([ks, label]) => <span key={label}>{ks.map((k) => <kbd key={k}>{k}</kbd>)}{label}</span>)}
    </div>
  );
}

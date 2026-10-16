import { MeterBar } from "./MeterBar";
import css from "./panels.module.css";

export type Gate = { gate: "L1->L2" | "L2->L3" | "L3->L4"; met: boolean; detail: string };
const CRITERIA: Record<Gate["gate"], string> = {
  "L1->L2": "≥ 50 resolved paper forecasts and Brier below market",
  "L2->L3": "≥ 30 approved live trades with avg slippage within 1¢ of modeled (phase 6)",
  "L3->L4": "≥ 100 live trades and positive 30-day realized edge (phase 6)",
};
/** First "a/b" pair in the detail string is the progress. */
const progress = (detail: string) => { const m = /(\d+)\/(\d+)/.exec(detail); return m ? { value: Number(m[1]), max: Number(m[2]) } : null; };

export function GatePanel({ gates }: { gates: Gate[] }) {
  return (
    <section className="pane">
      <h2>Gates <span className="muted" style={{ fontWeight: 400, fontSize: "var(--fs-sm)" }}>advisory; skipping is logged</span></h2>
      <table aria-label="gates">
        <thead><tr><th scope="col">Gate</th><th scope="col">Criteria</th><th scope="col" style={{ width: "20%" }}>Progress</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {gates.map((g) => {
            const p = progress(g.detail);
            return (
              <tr key={g.gate} className={g.met ? "pos" : "muted"}>
                <td>{g.gate.replace("->", "→")}</td>
                <td className="ui" style={{ whiteSpace: "normal" }}>{CRITERIA[g.gate]}</td>
                <td>{p && <MeterBar value={p.value} max={p.max} warnAt={2} />}</td>
                <td>{g.detail} {g.met ? "✓" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={`muted ui ${css.line}`} style={{ margin: 0 }}>Gates are advisory; skipping is logged.</p>
    </section>
  );
}

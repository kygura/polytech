import { gateParts, type Gate } from "./live";
import { MeterBar } from "./MeterBar";
import { Panel, Table } from "./ui";

export type { Gate };
const CRITERIA: Record<Gate["gate"], string> = {
  "L1->L2": "≥ 50 resolved paper forecasts and Brier below market",
  "L2->L3": "≥ 30 approved live trades with avg slippage within 1¢ of modeled",
  "L3->L4": "≥ 100 live trades and positive 30-day realized edge",
};
/** First "a/b" pair in the detail string is the progress. */
const progress = (detail: string) => { const m = /(\d+)\/(\d+)/.exec(detail); return m ? { value: Number(m[1]), max: Number(m[2]) } : null; };

export function GatePanel({ gates }: { gates: Gate[] }) {
  return (
    <Panel title="Gates" right="advisory; skipping is logged">
      <Table label="gates">
        <thead><tr><th scope="col">Gate</th><th scope="col">Criteria</th><th scope="col" style={{ width: "20%" }}>Progress</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {gates.map((g) => {
            const x = gateParts(g), p = x ?? progress(g.detail);
            return (
              <tr key={g.gate} className={g.met ? "up" : "muted"}>
                <td>{g.gate.replace("->", "→")}</td>
                <td className="ui" style={{ whiteSpace: "normal" }}>{CRITERIA[g.gate]}</td>
                <td>{p && <MeterBar value={p.value} max={p.max} warnAt={2} />}</td>
                <td>{x ? x.parts.map((c, i) => <span key={i}>{i ? <span className="muted"> · </span> : null}<span className={c.met ? "up" : "muted"}>{c.text}</span></span>) : g.detail} {g.met ? "✓" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

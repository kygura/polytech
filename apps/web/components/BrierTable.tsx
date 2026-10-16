import { fmt } from "./fmt";

export type Agg = { n: number; brier: number; logLoss: number; marketBrier: number };
export type CatAgg = Agg & { c: number; gate: string };

/** ours − market; negative is good → --pos. Sign always shown. */
export const Delta = ({ ours, market }: { ours: number; market: number }) => {
  const d = ours - market;
  return <span className={d < 0 ? "pos" : d > 0 ? "neg" : "muted"}>{fmt(d, "p", true)}</span>;
};

export function BrierTable({ byCategory, byModel }: { byCategory: Record<string, CatAgg>; byModel: Record<string, Agg> }) {
  const cats = Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b));
  const models = Object.entries(byModel).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <section className="pane">
        <h2>By category</h2>
        <table aria-label="brier by category">
          <thead><tr><th scope="col">Category</th><th scope="col" className="num">n</th><th scope="col" className="num">Brier</th><th scope="col" className="num">Mkt Brier</th><th scope="col" className="num">Δ</th><th scope="col" className="num">log loss</th><th scope="col" className="num">c</th><th scope="col" className="num">gate</th></tr></thead>
          <tbody>
            {cats.length ? cats.map(([k, v]) => (
              <tr key={k}>
                <td className="ui">{k}</td><td className="num">{v.n}</td><td className="num">{v.brier.toFixed(3)}</td><td className="num">{v.marketBrier.toFixed(3)}</td>
                <td className="num"><Delta ours={v.brier} market={v.marketBrier} /></td><td className="num">{v.logLoss.toFixed(2)}</td>
                <td className="num"><span className={v.n < 30 ? "warn" : undefined} title={v.n < 30 ? "c ≤ 0.4 until 30 resolved" : undefined}>{v.c.toFixed(2)}</span></td>
                <td className="num">{v.gate}{v.n >= 30 ? <span className="pos"> ✓</span> : ""}</td>
              </tr>
            )) : <tr><td colSpan={8} className="muted">No categories</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="pane">
        <h2>By model</h2>
        <table aria-label="brier by model">
          <thead><tr><th scope="col">Model</th><th scope="col" className="num">n</th><th scope="col" className="num">Brier</th><th scope="col" className="num">Mkt Brier</th><th scope="col" className="num">Δ</th><th scope="col" className="num">log loss</th></tr></thead>
          <tbody>
            {models.length ? models.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="num">{v.n}</td><td className="num">{v.brier.toFixed(3)}</td><td className="num">{v.marketBrier.toFixed(3)}</td><td className="num"><Delta ours={v.brier} market={v.marketBrier} /></td><td className="num">{v.logLoss.toFixed(2)}</td></tr>
            )) : <tr><td colSpan={6} className="muted">No models</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

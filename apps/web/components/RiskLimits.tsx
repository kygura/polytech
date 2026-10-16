import { MeterBar } from "./MeterBar";
import { fmt } from "./fmt";
import css from "./panels.module.css";

export type Limits = { perTradeUsd: number; perTradePct: number; perMarket: number; perEvent: number; perCategory: number; totalOpen: number; dailyNotional: number; dailyLoss: number };
export type Usage = { totalOpen: number; dailyNotional: number; dailyRealizedLoss: number; byCategory: Record<string, number> };

/** Read-only here (edit in Settings). Rows the exposure read does not report show used as —. */
export function RiskLimits({ limits: l, usage: u }: { limits: Limits; usage: Usage }) {
  const cats = Object.entries(u.byCategory);
  const topCat = cats.length ? cats.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const rows: [string, number, number | null, string?][] = [
    ["per-trade max", l.perTradeUsd, null, `${(l.perTradePct * 100).toFixed(0)}% B`],
    ["per-market", l.perMarket, null],
    ["per-event", l.perEvent, null],
    ["per-category", l.perCategory, topCat?.[1] ?? null, topCat ? `max: ${topCat[0]}` : undefined],
    ["total open", l.totalOpen, u.totalOpen],
    ["daily notional", l.dailyNotional, u.dailyNotional],
    ["daily loss", l.dailyLoss, u.dailyRealizedLoss],
  ];
  return (
    <section className="pane">
      <h2>Risk limits <span className="muted" style={{ fontWeight: 400, fontSize: "var(--fs-sm)" }}>read-only · edit in Settings</span></h2>
      <table className={css.kv} aria-label="risk limits">
        <thead><tr><th scope="col">Limit</th><th scope="col" className="num">limit $</th><th scope="col" className="num">used today</th><th scope="col" style={{ width: "30%" }}>bar</th></tr></thead>
        <tbody>
          {rows.map(([k, lim, used, note]) => (
            <tr key={k}>
              <td>{k}{note && <span className="muted"> · {note}</span>}</td>
              <td className="num">{fmt(lim, "usd")}</td>
              <td className="num">{used == null ? <span className="muted">{"—"}</span> : fmt(used, "usd")}</td>
              <td>{used == null ? null : <MeterBar value={used} max={lim} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

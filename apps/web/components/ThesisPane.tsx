import { EdgeBadge } from "./EdgeBadge";
import { NumCell } from "./NumCell";
import type { Detail } from "./detail";
import { ago, hm } from "./fmt";
import type { PublicMarketDetail } from "../lib/public";
import css from "./detail.module.css";

type T = NonNullable<Detail["thesis"]>;

/** `public`: the /trade form (DESIGN 10.3): no model or judge label, no operator sizing (Size$, E[P]$, r_ann, Payoff). */
export function ThesisPane({ thesis: t, now, public: pub = false }: { thesis: (NonNullable<PublicMarketDetail["thesis"]> & Partial<T>) | null; now: number; public?: boolean }) {
  if (!t) return <section className="pane"><h2>Thesis</h2><p className={`muted ${css.prose}`}>{pub ? "No thesis yet." : "No thesis yet. Re-research to start a pod."}</p></section>;
  const ageH = (now - t.createdAt) / 3_600_000;
  const pMidAtThesis = t.pMidYes == null ? null : t.side === "NO" ? 1 - t.pMidYes : t.pMidYes;
  const rows: [string, React.ReactNode][] = pub ? [
    ["Fair p", <NumCell value={t.pPost} fmt="p" />], ["Price at thesis", <NumCell value={pMidAtThesis} fmt="p" />],
    ["Edge¢", <EdgeBadge cents={t.edgeC} />], ["Conf", t.c.toFixed(2)], ["f*", <NumCell value={null} fmt="p" />],
  ] : [
    ["p̂", <NumCell value={t.pHat} fmt="p" />], ["c", t.c.toFixed(2)],
    ["p_post", <NumCell value={t.pPost} fmt="p" />], ["p_mid at thesis", <NumCell value={pMidAtThesis} fmt="p" />],
    ["Edge¢", <EdgeBadge cents={t.edgeC} />], ["Size$", <NumCell value={t.sizeUsd} fmt="usd" />],
    ["E[P]$", <NumCell value={t.expectedProfit} fmt="usd" signed />], ["r_ann", <NumCell value={t.rAnn} fmt="pct" />],
    ["Payoff", <NumCell value={t.payoff} fmt="x" />], ["f*", <NumCell value={null} fmt="p" />],
  ];
  return (
    <section className="pane">
      {pub
        ? <h2>Thesis {"·"} <span className={t.side === "YES" ? "pos" : "neg"}>{t.side}</span> {"·"} {hm(t.createdAt)} {"·"} <span className="muted">{ago(now - t.createdAt)}</span></h2>
        : <h2>Thesis {"·"} <span className={t.side === "YES" ? "pos" : "neg"}>{t.side}</span> {"·"} judge {"·"} {t.model ?? "—"} {"·"} {hm(t.createdAt)} {"·"} <span className="muted">{ago(now - t.createdAt)}</span></h2>}
      <dl className={css.numgrid}>
        {rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {t.capped && <p className={`warn ${css.line}`} style={{ paddingTop: "var(--sp-2)" }}>Confidence capped 0.5: agents straddle mid</p>}
      {ageH > 72 && <p className={`warn ${css.line}`}>Thesis {Math.round(ageH)}h old</p>}
      {t.expiresAt != null && t.expiresAt < now && <p className={`muted ${css.line}`}>Expired {"—"} re-research</p>}
      <p className={css.prose}>{t.thesis ?? <span className="muted">No thesis text.</span>}</p>
    </section>
  );
}

import { EdgeBadge } from "./EdgeBadge";
import { NumCell } from "./NumCell";
import type { Detail } from "./detail";
import { ago, hm } from "./fmt";
import { Panel } from "./ui";
import css from "./detail.module.css";

type T = NonNullable<Detail["thesis"]>;

/** Thesis · YES · judge · model · 09:12 · 3h ago, the number grid, then the prose (DESIGN 13.4 Research tab). */
export function ThesisPane({ thesis: t, now }: { thesis: T | null; now: number }) {
  if (!t) return <Panel title="Thesis" pad><p className={`muted ${css.prose}`}>No thesis yet. Re-research to start a pod.</p></Panel>;
  const ageH = (now - t.createdAt) / 3_600_000;
  const pMidAtThesis = t.pMidYes == null ? null : t.side === "NO" ? 1 - t.pMidYes : t.pMidYes;
  const rows: [string, React.ReactNode][] = [
    ["p̂", <NumCell value={t.pHat} fmt="p" />], ["c", t.c.toFixed(2)],
    ["p_post", <NumCell value={t.pPost} fmt="p" />], ["p_mid at thesis", <NumCell value={pMidAtThesis} fmt="p" />],
    ["Edge¢", <EdgeBadge cents={t.edgeC} />], ["Size$", <NumCell value={t.sizeUsd} fmt="usd" />],
    ["E[P]$", <NumCell value={t.expectedProfit} fmt="usd" signed />], ["r_ann", <NumCell value={t.rAnn} fmt="pct" />],
    ["Payoff", <NumCell value={t.payoff} fmt="x" />], ["f*", <NumCell value={null} fmt="p" />],
  ];
  return (
    <Panel label="Thesis" title={<span className={css.ttl}>Thesis {"·"} <span className={t.side === "YES" ? "yes" : "no"}>{t.side}</span> {"·"} judge {"·"} {t.model ?? "—"} {"·"} <span className={css.n}>{hm(t.createdAt)}</span> {"·"} <span className="muted">{ago(now - t.createdAt)}</span></span>}>
      <dl className={css.numgrid}>
        {rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className={css.n}>{v}</dd></div>)}
      </dl>
      {t.capped && <p className={`warn ${css.line}`} style={{ paddingTop: "var(--sp-2)" }}>Confidence capped 0.5: agents straddle mid</p>}
      {ageH > 72 && <p className={`warn ${css.line}`}>Thesis {Math.round(ageH)}h old</p>}
      {t.expiresAt != null && t.expiresAt < now && <p className={`muted ${css.line}`}>Expired {"—"} re-research</p>}
      <p className={css.prose}>{t.thesis ?? <span className="muted">No thesis text.</span>}</p>
    </Panel>
  );
}

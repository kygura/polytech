import Link from "next/link";
import { EdgeBadge } from "../EdgeBadge";
import { EmptyState } from "../EmptyState";
import { Panel } from "../ui";
import { fmt } from "../fmt";
import css from "./runs.module.css";
import { usd1s } from "./runs";

export type Thesis = { side: string; pHat: number; c: number; pPost: number; edgeC: number | null; sizeUsd: number | null; rAnn: number | null; pMidYes?: number; payoff?: number; expectedProfit?: number };

export function ResultCard({ thesis: t, pPre, conditionId }: { thesis: Thesis | null; pPre: number | null; conditionId: string }) {
  if (!t) return <Panel title="Result"><EmptyState text="No thesis was written." /></Panel>;
  const mid = t.pMidYes == null ? null : t.side === "NO" ? 1 - t.pMidYes : t.pMidYes; // side frame, as ThesisPane
  const trade = (t.edgeC ?? 0) > 0 && (t.sizeUsd ?? 0) > 0;
  const yes = t.side === "YES";
  return (
    <Panel title="Result"><div className={css.result}>
      <div className={css.r1}>
        <span><i>p̂</i>{fmt(t.pHat, "p")}</span>
        <span><i>p_post</i>{fmt(t.pPost, "p")}</span>
        <span><i>p_pre</i>{fmt(pPre, "p")}</span>
        <span><i>mid</i>{fmt(mid, "p")}</span>
        <span><i>Edge¢</i><EdgeBadge cents={t.edgeC} /></span>
        <span><i>c</i>{t.c.toFixed(2)}</span>
      </div>
      <div className={css.r2}>
        {trade ? (
          <>
            <span className={yes ? "yes" : "no"}>BUY {t.side}</span> {"≤"} ${fmt(t.sizeUsd, "usd")}
            {t.expectedProfit != null && <> {"·"} E[P] {usd1s(t.expectedProfit)}</>}
            {t.rAnn != null && <> {"·"} r_ann {fmt(t.rAnn, "pct")}</>}
            {t.payoff != null && <> {"·"} payoff {fmt(t.payoff, "x")}</>}
          </>
        ) : <span className="muted">NO TRADE {"·"} best side {t.side} edge {fmt(t.edgeC, "cents", true)}{"¢"}</span>}
      </div>
      <div><Link href={`/trade/${encodeURIComponent(conditionId)}`}>Open thesis {"→"}</Link></div>
    </div></Panel>
  );
}

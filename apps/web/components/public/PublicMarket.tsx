"use client";
// /trade/[id] (DESIGN 10.3): polled public detail; TradeTicket moves right under the header on one column.
import Link from "next/link";
import { useState } from "react";
import { usePoll } from "../../hooks/usePoll";
import type { PublicMarketDetail } from "../../lib/public";
import { CatalystList } from "../CatalystList";
import { DepthChart } from "../DepthChart";
import { EmptyState } from "../EmptyState";
import { ErrorBar } from "../ErrorBar";
import { EvidenceTable } from "../EvidenceTable";
import { KillCriteriaList } from "../KillCriteriaList";
import { MarketHeader } from "../MarketHeader";
import { PriceHistoryChart } from "../PriceHistoryChart";
import { Skeleton } from "../Skeleton";
import { ThesisPane } from "../ThesisPane";
import { hm } from "../fmt";
import ui from "../ui.module.css";
import { AccountPanel } from "./AccountPanel";
import { TradeTicket } from "./TradeTicket";
import css from "./public.module.css";

const STALE_MS = 6 * 3_600_000; // same 6 h hint as lib/public.ts STALE_MS (server module, not importable here)

/** `base rate 0.41 · news 0.52 · … → fair 0.47`: roles only, YES probabilities. */
export function EstimatesStrip({ agents, fair }: { agents: PublicMarketDetail["agents"]; fair: number | null }) {
  const parts = agents.filter((a) => a.role !== "rules" && a.role !== "judge" && a.probability != null).map((a) => `${a.role.replace(/_/g, " ")} ${a.probability!.toFixed(2)}`);
  if (!parts.length) return null;
  return (
    <section className="pane" aria-label="agent estimates">
      <h2>Estimates</h2>
      <p className={css.strip} style={{ margin: 0 }}>{parts.join(" · ")}{fair != null && ` → fair ${fair.toFixed(2)}`}</p>
    </section>
  );
}

export function RulesPane({ rules }: { rules: string | null }) {
  const [full, setFull] = useState(false);
  if (!rules) return null;
  const long = rules.split("\n").length > 6 || rules.length > 600;
  return (
    <section className="pane">
      <h2>Rules</h2>
      <p className={`${css.rules} ${full ? "" : css.rulesClamp}`}>{rules}</p>
      {long && <p style={{ margin: 0, padding: "0 var(--sp-3) var(--sp-3)" }}><button type="button" className={css.linkBtn} aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Show less" : "Show full rules"}</button></p>}
    </section>
  );
}

export function PublicMarket({ id }: { id: string }) {
  const poll = usePoll<PublicMarketDetail>(`/api/public/markets/${encodeURIComponent(id)}`, 60_000);
  const d = poll.data;
  const back = <Link href="/trade" className={css.back}>{"←"} Watchlist</Link>;

  if (!d) {
    if (poll.status === 404) return <>{back}<EmptyState text="This market is not on the public list." action={<Link href="/trade">Back to the watchlist</Link>} /></>;
    if (poll.error) return <>{back}<ErrorBar message={`Could not load the market (${poll.error}). Retrying in 60 s.`} onRetry={poll.refresh} /></>;
    return <>{back}<p className="muted ui" role="status">Loading market…</p><Skeleton rows={8} /></>;
  }

  const now = poll.lastAt ?? Date.now();
  const snapTs = d.snapshot?.ts ?? null;
  const t = d.thesis;
  return (
    <>
      {back}
      {poll.error && <ErrorBar message={`Refresh failed (${poll.error}) · showing last loaded data`} onRetry={poll.refresh} />}
      {(snapTs == null || now - snapTs > STALE_MS) && (
        <div className={`${ui.bar} ${ui.barWarn}`} role="status">
          <span className="warn">Data may be out of date {"·"} {snapTs == null ? "no snapshot yet" : `last snapshot ${hm(snapTs)} (${Math.round((now - snapTs) / 3_600_000)} h)`}</span>
        </div>
      )}
      <div className={css.grid}>
        <div className={css.col}>
          <div className={css.first}><MarketHeader market={d.market} snapshot={d.snapshot} history={d.history} now={now} /></div>
          <section className="pane">
            <h2>Price history</h2>
            <div className="body"><PriceHistoryChart series={d.history} markers={d.thesisMarkers.map((m) => ({ ts: m.createdAt, pHat: m.pHat, side: m.side }))} /></div>
          </section>
          <section className="pane">
            <h2>Book</h2>
            <div className="body"><DepthChart bids={d.snapshot?.bids ?? []} asks={d.snapshot?.asks ?? []} mid={d.snapshot?.mid ?? null} k={null} /></div>
          </section>
          <section className="pane">
            <h2>Sources ({d.evidence.length})</h2>
            <EvidenceTable evidence={d.evidence} />
          </section>
          <RulesPane rules={d.market.rules} />
        </div>
        <div className={css.col}>
          <div className={css.second} style={{ display: "grid", gap: "var(--sp-3)" }}>
            <TradeTicket d={d} />
            <AccountPanel d={d} />
          </div>
          {d.research === "researching" && !t ? <section className="pane"><h2>Thesis</h2><p className="muted ui" style={{ margin: 0, padding: "var(--sp-3)" }}>Research is running on this market.</p></section>
            : d.research === "disabled" && !t ? <section className="pane"><h2>Thesis</h2><p className="muted ui" style={{ margin: 0, padding: "var(--sp-3)" }}>Research is paused on this instance. Market data still updates.</p></section>
            : <ThesisPane thesis={t} now={now} public />}
          <KillCriteriaList items={t?.killCriteria ?? []} />
          <CatalystList items={t?.catalysts ?? []} now={now} />
          <EstimatesStrip agents={d.agents} fair={t?.pYes ?? null} />
        </div>
      </div>
    </>
  );
}

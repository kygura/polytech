import { notFound } from "next/navigation";
import { ALLOWED_MODELS } from "@pm/core";
import { ActionBar } from "../../../../components/ActionBar";
import { AgentEstimates } from "../../../../components/AgentEstimates";
import { BackLink } from "../../../../components/BackLink";
import { CatalystList } from "../../../../components/CatalystList";
import { DepthChart } from "../../../../components/DepthChart";
import { EvidenceTable } from "../../../../components/EvidenceTable";
import { KillCriteriaList } from "../../../../components/KillCriteriaList";
import { MarketHeader } from "../../../../components/MarketHeader";
import { MetricsGrid } from "../../../../components/MetricsGrid";
import { PriceHistoryPane } from "../../../../components/PriceHistoryPane";
import { SlippagePane } from "../../../../components/SlippagePane";
import { STALE_MS, StaleBanner } from "../../../../components/StaleBanner";
import { ThesisPane } from "../../../../components/ThesisPane";
import { listProfiles, read } from "../../../../lib/jobs";
import { DEFAULT_RANGE, parseRange } from "../../../../lib/history";
import { researchDisabled } from "../../../../lib/public";
import type { StructDetail } from "../../../../lib/jobs/screen";
import css from "./detail.module.css";

export default async function MarketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string | string[] }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const range = parseRange(Array.isArray(sp.range) ? sp.range[0] : sp.range) ?? DEFAULT_RANGE;
  const r = await read.readDeps();
  const [d, profiles, disabled] = await Promise.all([read.marketDetail(r, id), listProfiles(r.db), researchDisabled()]);
  if (!d) notFound();
  const now = r.now();
  const stale = d.snapshot == null || now - d.snapshot.ts > STALE_MS;
  const running = d.pod?.status === "running" ? { startedAt: d.pod.startedAt } : null;
  const l = d.latest;
  const flags = l && { structural: l.structural, contrarian: !!l.opportunity?.contrarian, lastTradeTs: l.lastTradeTs, detail: (d.screen?.structural ?? null) as StructDetail | null };

  return (
    <>
      <BackLink className={css.back} />
      {stale && <StaleBanner lastSnapshotAt={d.snapshot?.ts ?? null} now={now} />}
      <div className={css.grid}>
        <div className={css.col}>
          <MarketHeader market={d.market} snapshot={d.snapshot} history={d.history} now={now} flags={flags ?? undefined} />
          <ActionBar conditionId={id} pinned={d.market.pinned} muted={d.market.muted} running={running} now={now} question={d.market.question}
            profiles={profiles.map((p) => ({ id: p.id, name: p.name, steering: p.steering }))} models={ALLOWED_MODELS} researchDisabled={disabled} />
          <PriceHistoryPane conditionId={id} initialRange={range} fallback={d.history} markers={d.thesisMarkers.map((m) => ({ ts: m.createdAt, pHat: m.pHat, side: m.side }))} />
          <section className="pane">
            <h2>Book</h2>
            <div className="body"><DepthChart bids={d.snapshot?.bids ?? []} asks={d.snapshot?.asks ?? []} mid={d.snapshot?.mid ?? null} k={d.thesis?.k ?? null} /></div>
          </section>
          <SlippagePane conditionId={id} snapshot={d.snapshot && { ts: d.snapshot.ts, bids: d.snapshot.bids, asks: d.snapshot.asks }} defaultSide={d.thesis?.side ?? "YES"} />
          <section className="pane">
            <h2>Metrics</h2>
            <MetricsGrid latest={l} market={d.market} oi={d.snapshot?.oi ?? null} now={now} />
          </section>
          <section className="pane">
            <h2>Evidence ({d.evidence.length})</h2>
            <EvidenceTable evidence={d.evidence} />
          </section>
        </div>
        <div className={css.col}>
          <ThesisPane thesis={d.thesis} now={now} />
          <KillCriteriaList items={d.thesis?.killCriteria ?? []} />
          <CatalystList items={d.thesis?.catalysts ?? []} now={now} />
          <AgentEstimates agents={d.agents} />
        </div>
      </div>
    </>
  );
}

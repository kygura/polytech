import Link from "next/link";
import { notFound } from "next/navigation";
import { ALLOWED_MODELS } from "@pm/core";
import { ActionBar } from "../../../../components/ActionBar";
import { AgentEstimates } from "../../../../components/AgentEstimates";
import { CatalystList } from "../../../../components/CatalystList";
import { DepthChart } from "../../../../components/DepthChart";
import { EvidenceTable } from "../../../../components/EvidenceTable";
import { KillCriteriaList } from "../../../../components/KillCriteriaList";
import { MarketHeader } from "../../../../components/MarketHeader";
import { PriceHistoryChart } from "../../../../components/PriceHistoryChart";
import { STALE_MS, StaleBanner } from "../../../../components/StaleBanner";
import { ThesisPane } from "../../../../components/ThesisPane";
import { listProfiles, read } from "../../../../lib/jobs";
import { researchDisabled } from "../../../../lib/public";
import css from "./detail.module.css";

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await read.readDeps();
  const [d, profiles, disabled] = await Promise.all([read.marketDetail(r, id), listProfiles(r.db), researchDisabled()]);
  if (!d) notFound();
  const now = r.now();
  const stale = d.snapshot == null || now - d.snapshot.ts > STALE_MS;
  const running = d.pod?.status === "running" ? { startedAt: d.pod.startedAt } : null;

  return (
    <>
      <Link href="/watchlist" className={css.back}>{"←"} Watchlist</Link>
      {stale && <StaleBanner lastSnapshotAt={d.snapshot?.ts ?? null} now={now} />}
      <div className={css.grid}>
        <div className={css.col}>
          <MarketHeader market={d.market} snapshot={d.snapshot} history={d.history} now={now} />
          <ActionBar conditionId={id} pinned={d.market.pinned} muted={d.market.muted} running={running} now={now} question={d.market.question}
            profiles={profiles.map((p) => ({ id: p.id, name: p.name, steering: p.steering }))} models={ALLOWED_MODELS} researchDisabled={disabled} />
          <section className="pane">
            <h2>Price history</h2>
            <div className="body"><PriceHistoryChart series={d.history} markers={d.thesisMarkers.map((m) => ({ ts: m.createdAt, pHat: m.pHat, side: m.side }))} /></div>
          </section>
          <section className="pane">
            <h2>Book</h2>
            <div className="body"><DepthChart bids={d.snapshot?.bids ?? []} asks={d.snapshot?.asks ?? []} mid={d.snapshot?.mid ?? null} k={d.thesis?.k ?? null} /></div>
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

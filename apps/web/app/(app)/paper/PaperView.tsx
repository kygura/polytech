"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorBar } from "../../../components/ErrorBar";
import { FillsTable } from "../../../components/FillsTable";
import { LinkButton } from "../../../components/pageParts";
import { PnlStrip } from "../../../components/PnlStrip";
import { PositionsTable, type PaperBook } from "../../../components/PositionsTable";
import pg from "../../../components/page.module.css";
import { Panel } from "../../../components/ui";

// Manual trades from the Trade page are booked under thesisId "manual": no thesis to link to.
const MANUAL = "manual";

export function PaperView({ data }: { data: PaperBook }) {
  const router = useRouter();
  const positions = useMemo(() => data.positions.map((p) => (p.thesisId === MANUAL ? { ...p, thesisId: null } : p)), [data.positions]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const close = async (id: number) => {
    setErr(null);
    const r = await fetch(`/api/paper/${id}/close`, { method: "POST" });
    if (!r.ok) setErr(`Close failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    router.refresh();
  };
  return (
    <div className={pg.stack}>
      {err && <ErrorBar message={err} onRetry={() => setErr(null)} />}
      <Panel title="Paper book" label="Paper P&L">
        <p className={`${pg.hint} ${pg.line}`}>Manual paper trades from the Trade page and L1 autonomy fills. Fills use the real order book; no real money.</p>
        <PnlStrip summary={data.summary} />
      </Panel>
      {!positions.length && !data.fills.length && (
        <Panel title="Positions">
          <EmptyState text="No paper trades yet. Trade with the header switch on Paper, or set Autonomy to L1 to let the system paper-trade." action={<LinkButton href="/trade">Trade {"→"}</LinkButton>} />
        </Panel>
      )}
      {(positions.length > 0 || data.fills.length > 0) && <Panel title="Positions">
        <PositionsTable positions={positions} onClose={close} onOpen={(p) => router.push(`/trade/${encodeURIComponent(p.conditionId)}`)} selected={selected} onSelect={setSelected} />
      </Panel>}
      <Panel title="Fills" right={<span className="n">{data.fills.length}</span>}>
        <FillsTable fills={data.fills} />
      </Panel>
    </div>
  );
}

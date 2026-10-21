"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBar } from "../../../components/ErrorBar";
import { FillsTable } from "../../../components/FillsTable";
import { PnlStrip } from "../../../components/PnlStrip";
import { PositionsTable, type PaperBook } from "../../../components/PositionsTable";
import pg from "../../../components/page.module.css";
import { Panel } from "../../../components/ui";

export function PaperView({ data }: { data: PaperBook }) {
  const router = useRouter();
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
      <Panel title="Paper book" label="Paper P&L"><PnlStrip summary={data.summary} /></Panel>
      <Panel title="Positions">
        <PositionsTable positions={data.positions} onClose={close} onOpen={(p) => router.push(`/trade/${encodeURIComponent(p.conditionId)}`)} selected={selected} onSelect={setSelected} />
      </Panel>
      <Panel title="Fills" right={<span className="n">{data.fills.length}</span>}>
        <FillsTable fills={data.fills} />
      </Panel>
    </div>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBar } from "../../../components/ErrorBar";
import { FillsTable } from "../../../components/FillsTable";
import { PnlStrip } from "../../../components/PnlStrip";
import { PositionsTable, type PaperBook } from "../../../components/PositionsTable";

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
    <>
      {err && <ErrorBar message={err} onRetry={() => setErr(null)} />}
      <PnlStrip summary={data.summary} />
      <section className="pane">
        <h2>Positions</h2>
        <PositionsTable positions={data.positions} onClose={close} onOpen={(p) => router.push(`/markets/${p.conditionId}`)} selected={selected} onSelect={setSelected} />
      </section>
      <section className="pane" style={{ marginTop: "var(--sp-3)" }}>
        <h2>Fills</h2>
        <FillsTable fills={data.fills} />
      </section>
    </>
  );
}

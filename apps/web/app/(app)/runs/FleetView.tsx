"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BudgetStrip } from "../../../components/BudgetStrip";
import { EmptyState } from "../../../components/EmptyState";
import { Flat } from "../../../components/pageParts";
import { Panel } from "../../../components/ui";
import pg from "../../../components/page.module.css";
import { PodTable, orderPods, type Fleet } from "../../../components/PodTable";
import { useSse } from "../../../hooks/useSse";

export function FleetView({ data, now }: { data: Fleet; now: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [t, setT] = useState(now);
  // Any pod.* event (stage, agent, cancelled, ...) moves a row; the shell's debounced refresh only covers lifecycle events.
  useSse((e) => { if (e.type.startsWith("pod.")) router.refresh(); });
  useEffect(() => { const id = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(id); }, []);
  // Ids present at mount; anything later is "new" and gets the one allowed flash.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(data.pods.map((p) => p.id));
  const isNew = (p: { id: string }) => !seen.current!.has(p.id);
  useEffect(() => { const s = seen.current!; const id = setTimeout(() => data.pods.forEach((p) => s.add(p.id)), 1500); return () => clearTimeout(id); }, [data.pods]);

  const pods = orderPods(data.pods);
  return (
    <div className={pg.stack}>
      <div className="page-h"><h1>Runs</h1></div>
      <Panel title="Budget today"><BudgetStrip budget={data.budget} /></Panel>
      <Panel title="Pods" right={<span className="n">{pods.length}</span>}>
        {pods.length ? (
          <Flat><PodTable pods={pods} now={t} selected={selected} onSelect={setSelected} onOpen={(pod) => router.push(`/runs/${pod.id}`)} isNew={isNew} /></Flat>
        ) : <EmptyState text="No runs yet. Press r on a market." />}
      </Panel>
    </div>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BudgetStrip } from "../../../components/BudgetStrip";
import { EmptyState } from "../../../components/EmptyState";
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
    <>
      <BudgetStrip budget={data.budget} />
      {pods.length ? (
        <PodTable pods={pods} now={t} selected={selected} onSelect={setSelected} onOpen={(p) => router.push(`/runs/${p.id}`)} isNew={isNew} />
      ) : <EmptyState text="No runs yet. Press r on a market." />}
    </>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AgentRunTable, type AgentRun } from "../../../components/AgentRunTable";
import { BudgetStrip } from "../../../components/BudgetStrip";
import { Drawer } from "../../../components/Drawer";
import { EmptyState } from "../../../components/EmptyState";
import { PodTable, orderPods, steeringLine, type Fleet } from "../../../components/PodTable";
import { useSse } from "../../../hooks/useSse";
import css from "../../../components/panels.module.css";

export function FleetView({ data, now }: { data: Fleet; now: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<AgentRun | null>(null);
  const [t, setT] = useState(now);
  // The shell refreshes on pod.started/done/failed; agent-level progress needs pod.agent too.
  useSse((e) => { if (e.type === "pod.agent") router.refresh(); });
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
        <PodTable pods={pods} now={t} selected={selected} onSelect={setSelected} isNew={isNew}
          renderExpanded={(p) => (
            <>
              {p.steeringQuestion && <p className="ui muted" style={{ whiteSpace: "pre-wrap", margin: "0 0 var(--sp-2)" }}><b>steering</b> {p.steeringQuestion}</p>}
              {steeringLine(p.steering) && <p className="muted" style={{ margin: "0 0 var(--sp-2)" }}>{steeringLine(p.steering)}</p>}
              <AgentRunTable agents={p.agents} onView={setOutput} />
            </>
          )} />
      ) : <EmptyState text="No pods running." />}
      <Drawer open={output != null} title={output ? `${output.role} · ${output.model} output` : ""} onClose={() => setOutput(null)}>
        {output && <pre className={css.pre}>{JSON.stringify(output.output, null, 2)}</pre>}
      </Drawer>
    </>
  );
}

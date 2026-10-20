"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "../Drawer";
import { ErrorBar } from "../ErrorBar";
import { inInput } from "../../hooks/useGlobalKeys";
import { fetchOnce, usePoll } from "../../hooks/usePoll";
import { useSse } from "../../hooks/useSse";
import type { read } from "../../lib/jobs";
import { AgentTable, type Agent } from "./AgentTable";
import { CancelDialog } from "./CancelDialog";
import { EvidenceStream } from "./EvidenceStream";
import { ResultCard } from "./ResultCard";
import { RunHeader } from "./RunHeader";
import { blindMean, byRole, elapsedS, isLive } from "./runs";
import panels from "../panels.module.css";
import css from "./runs.module.css";

export type PodDetail = NonNullable<Awaited<ReturnType<typeof read.podDetail>>>;

export function RunDetail({ initial, now }: { initial: PodDetail; now: number }) {
  const [d, setD] = useState(initial);
  const [t, setT] = useState(now);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<Agent | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [posted, setPosted] = useState(false); // cancel accepted by the server in this tab
  const [error, setError] = useState<string | null>(null);
  const id = d.pod.id;
  const live = isLive(d.pod.status);
  const url = `/api/pods/${id}`;

  // 5 s poll while live (runs are live across instances); SSE events for this pod refetch at once.
  const poll = usePoll<PodDetail>(live ? url : null, 5000);
  useEffect(() => { if (poll.data) setD(poll.data); }, [poll.data]);
  const seq = useRef(0);
  const refetch = useCallback(async () => {
    const n = ++seq.current;
    const r = await fetchOnce<PodDetail>(url);
    if (r?.data && n === seq.current) setD(r.data);
  }, [url]);
  useSse((e) => {
    if (e.type.startsWith("pod.") && e.payload.podId === id) void refetch();
  });

  // Elapsed and duration cells tick locally while live.
  useEffect(() => {
    if (!live) return;
    setT(Date.now());
    const i = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(i);
  }, [live]);

  const cancelling = live && (posted || d.pod.cancelRequestedAt != null);
  useEffect(() => { if (!live) setPosted(false); }, [live]);
  const askCancel = useCallback(() => { if (live && !cancelling) setConfirm(true); }, [live, cancelling]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "x" && !e.metaKey && !e.ctrlKey && !e.altKey && !inInput(e)) askCancel(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [askCancel]);

  const doCancel = async () => {
    setConfirm(false);
    setError(null);
    try {
      const r = await fetch(`${url}/cancel`, { method: "POST" });
      if (r.status === 202) setPosted(true);
      else setError(r.status === 409 ? "Run is no longer running." : `Cancel failed (HTTP ${r.status}).`);
    } catch {
      setError("Cancel failed (network error).");
    }
    void refetch();
  };

  const agents = d.agents as Agent[];
  const tools = agents.reduce((n, a) => n + a.toolCalls.length, 0);
  const failedAgent = agents.find((a) => a.status === "failed");
  const agentErr = (failedAgent?.output as { error?: unknown } | null)?.error;
  const elapsed = elapsedS(d.pod, agents, t);

  return (
    <div className={css.stack}>
      <Link href="/runs" className={css.back}>{"←"} Runs</Link>
      <RunHeader pod={d.pod} elapsed={elapsed} costUsd={d.pod.cost.costUsd} tools={tools} budget={d.budget} cancelling={cancelling} onCancel={askCancel} />
      {error && <ErrorBar message={error} onDismiss={() => setError(null)} />}
      {d.pod.status === "failed" && <ErrorBar message={`Run failed at stage ${d.pod.stage ?? "start"}${failedAgent ? ` (${failedAgent.role}${typeof agentErr === "string" ? `: ${agentErr}` : ""})` : ""}`} />}
      {d.pod.status === "done" && <ResultCard thesis={d.thesis} pPre={blindMean(agents)} conditionId={d.pod.conditionId} />}
      <AgentTable agents={agents} now={t} selected={selected} onSelect={setSelected} onView={setOutput} />
      <EvidenceStream evidence={d.evidence} />
      <CancelDialog open={confirm} onKeep={() => setConfirm(false)} onConfirm={doCancel} />
      <Drawer open={output != null} title={output ? `${output.role} · ${output.model} output` : ""} onClose={() => setOutput(null)}>
        {output && <pre className={panels.pre}>{JSON.stringify(output.output, null, 2)}</pre>}
      </Drawer>
    </div>
  );
}

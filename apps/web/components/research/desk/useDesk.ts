"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePoll } from "../../../hooks/usePoll";
import { freeSlots, POLL_BUSY_MS, POLL_IDLE_MS, pump, startOutcome, unseen, type Live, type NotStarted, type QItem } from "./desk";

export async function post(url: string, body?: unknown) {
  try {
    const r = await fetch(url, { method: "POST", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => null) };
  } catch { return null; }
}

/**
 * Live runs poll + the desk's start queue. The queue lives in this browser tab: it starts markets one request each, up to the free run slots,
 * puts a market back when all slots are busy (409 MAX_CONCURRENT_SANDBOXES) and waits for the next poll before trying again.
 */
export function useDesk() {
  const [queue, setQueue] = useState<QItem[]>([]);
  const [notStarted, setNotStarted] = useState<NotStarted[]>([]);
  const [pending, setPending] = useState<(QItem & { at: number })[]>([]); // 202 received, pod not yet in the poll
  const [inFlight, setInFlight] = useState<QItem[]>([]);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const live = usePoll<Live>("/api/research/live", busy ? POLL_BUSY_MS : POLL_IDLE_MS);
  const runs = live.data?.runs;
  const running = !!runs?.some((r) => r.status === "running");
  useEffect(() => setBusy(running || queue.length > 0 || inFlight.length > 0 || pending.length > 0), [running, queue.length, inFlight.length, pending.length]);

  const lastAt = useRef(live.lastAt);
  lastAt.current = live.lastAt;
  const held = useRef<number | null>(null); // lastAt of the poll a slots-409 came back against
  const refresh = live.refresh;

  useEffect(() => { if (runs) setPending((p) => { const n = unseen(p, runs, Date.now()); return n.length === p.length ? p : n; }); }, [runs]);

  const begin = useCallback(async (it: QItem) => {
    const at = Date.now();
    const res = await post(`/api/markets/${encodeURIComponent(it.id)}/research`);
    const o = startOutcome(res?.status ?? null, res?.j);
    setInFlight((s) => s.filter((x) => x.id !== it.id));
    if (o.kind === "started") { setPending((p) => [...p, { ...it, at }]); refresh(); }
    else if (o.kind === "requeue") { held.current = lastAt.current; setQueue((q) => [it, ...q.filter((x) => x.id !== it.id)]); }
    else setNotStarted((n) => [{ ...it, reason: o.reason, at: Date.now() }, ...n.filter((x) => x.id !== it.id)]);
  }, [refresh]);

  useEffect(() => {
    const b = live.data?.budget ?? null;
    if (!queue.length || !b || !runs) return;
    const pend = unseen(pending, runs, Date.now()).length + inFlight.length;
    const { start, rest } = pump(queue, freeSlots(b, pend), held.current != null && held.current === live.lastAt);
    if (!start.length) return;
    held.current = null;
    setQueue(rest);
    setInFlight((s) => [...s, ...start]);
    for (const it of start) void begin(it);
  }, [queue, live.lastAt, inFlight.length, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the tab drops queued markets (running ones keep going on the server).
  useEffect(() => {
    if (!queue.length) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [queue.length]);

  /** Adds markets not already queued, starting or running. Returns how many were added. */
  const enqueue = useCallback((items: QItem[]) => {
    const busyIds = new Set([...queue.map((x) => x.id), ...inFlight.map((x) => x.id), ...pending.map((x) => x.id), ...(runs ?? []).filter((r) => r.status === "running").map((r) => r.conditionId)]);
    const add = items.filter((x, i) => !busyIds.has(x.id) && items.findIndex((y) => y.id === x.id) === i);
    if (!add.length) return 0;
    setNotStarted((n) => n.filter((x) => !add.some((a) => a.id === x.id)));
    setQueue((q) => [...q, ...add]);
    refresh();
    return add.length;
  }, [queue, inFlight, pending, runs, refresh]);

  const dequeue = useCallback((id: string) => setQueue((q) => q.filter((x) => x.id !== id)), []);
  const dismiss = useCallback((id: string) => setNotStarted((n) => n.filter((x) => x.id !== id)), []);
  const cancel = useCallback(async (podId: string) => {
    setCancelling((c) => [...c, podId]);
    await post(`/api/pods/${encodeURIComponent(podId)}/cancel`);
    setCancelling((c) => c.filter((x) => x !== podId));
    refresh();
  }, [refresh]);

  return { live, queue, notStarted, starting: [...inFlight, ...pending], cancelling, enqueue, dequeue, dismiss, cancel };
}
export type Desk = ReturnType<typeof useDesk>;

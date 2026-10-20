"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAlerts } from "../hooks/useAlerts";
import { CHORD_MS, inInput } from "../hooks/useGlobalKeys";
import { alertHref, type Alert } from "./alerts";
import { AlertsList } from "./AlertsList";
import { Drawer } from "./Drawer";
import { ErrorBar } from "./ErrorBar";
import css from "./alerts.module.css";

/** Right-rail alerts drawer (DESIGN 12.5): ack / ack all / show acked. Polls while open; `refreshKey` bumps on SSE alert.created / alert.acked. `onUnacked` keeps the status bar count in step. */
export function AlertsDrawer({ open, onClose, refreshKey, onUnacked }: { open: boolean; onClose: () => void; refreshKey: number; onUnacked: (n: number) => void }) {
  const router = useRouter();
  const [showAcked, setShowAcked] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const a = useAlerts({ enabled: open, showAcked, refreshKey, onUnacked });

  const openRow = useCallback((row: Alert) => {
    if (row.ackedAt == null) void a.ack(row.id);
    const href = alertHref(row);
    if (href) { onClose(); router.push(href); }
  }, [a, onClose, router]);

  // The hook ignores keys while a dialog is open, so `g n` (toggle) is handled here.
  useEffect(() => {
    if (!open) return;
    let g = 0;
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inInput(e)) return;
      if (e.key === "n" && g && Date.now() - g < CHORD_MS) { e.preventDefault(); g = 0; onClose(); return; }
      g = e.key === "g" ? Date.now() : 0;
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  const hasRows = a.rows.length > 0;
  useEffect(() => { if (open && hasRows) list.current?.focus(); }, [open, hasRows]);

  return (
    <Drawer open={open} onClose={onClose} className={css.rail} title={`Alerts · ${a.unacked} unacked`}
      actions={<>
        {a.unacked > 0 && <button type="button" onClick={() => void a.ack()}>ack all (A)</button>}
        <label className={css.showAcked}><input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />show acked</label>
      </>}>
      {a.error && <ErrorBar message={a.error} onRetry={() => { a.clearError(); void a.reload(); }} onDismiss={a.clearError} />}
      {a.loaded || hasRows
        ? <AlertsList rows={a.rows} listRef={list} emptyText={showAcked ? "Nothing acked yet." : "No alerts."} onAck={(id) => void a.ack(id)} onAckAll={() => void a.ack()} onOpen={openRow} />
        : !a.error && <p className="muted ui">Loading…</p>}
    </Drawer>
  );
}

import Link from "next/link";
import { useEffect, useState } from "react";
import cx from "../../app/(app)/research/research.module.css";

export type Status = { tone: "pos" | "warn" | "neg" | "muted"; text: string; fleet?: boolean } | null;

/** Name, enabled, Preview/Run/Save/Delete (inline two-step delete) and the status line. */
export function ProfileToolbar({ name, enabled, nameError, dirty, isNew, blocker, busy, runDisabled, status, onName, onEnabled, onPreview, onRun, onSave, onDelete }: {
  name: string; enabled: boolean; nameError?: string; dirty: boolean; isNew: boolean; blocker: string | null; busy: boolean; runDisabled: boolean; status: Status;
  onName: (v: string) => void; onEnabled: (v: boolean) => void; onPreview: () => void; onRun: () => void; onSave: () => void; onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setConfirm(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [confirm]);
  const canRun = !isNew && !dirty && !busy && !runDisabled;
  return (
    <div className={cx.toolbar} role="toolbar" aria-label="profile actions">
      <div className={cx.tools}>
        <input className={cx.name} aria-label="profile name" aria-invalid={!!nameError} placeholder="profile name" maxLength={80} value={name} onChange={(e) => onName(e.target.value)} />
        {dirty && <><span className="warn" title="unsaved changes">{"•"}</span><span className="muted">unsaved</span></>}
        <label className={cx.check}><input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />enabled</label>
        <span className={cx.spacer} />
        <button type="button" onClick={onPreview} disabled={busy}>Preview matches<span className={cx.hint}>p</span></button>
        <button type="button" onClick={onRun} disabled={!canRun} title={runDisabled ? "Research is disabled on this server" : isNew || dirty ? "Save first — Run now uses the saved profile" : undefined}>Run now<span className={cx.hint}>x</span></button>
        <button type="button" className={cx.primary} onClick={onSave} disabled={!dirty || !!blocker || busy} title={blocker ?? undefined}>Save<span className={cx.hint}>Ctrl+Enter</span></button>
        {!isNew && (confirm
          ? <>
              <span className="warn">Delete?</span>
              <button type="button" className={cx.danger} onClick={() => { setConfirm(false); onDelete(); }}>Confirm</button>
              <button type="button" onClick={() => setConfirm(false)}>Cancel</button>
            </>
          : <button type="button" className={cx.danger} onClick={() => setConfirm(true)}>Delete</button>)}
      </div>
      {confirm && <span className={`${cx.line} muted`}>Delete &lsquo;{name}&rsquo;? Past pods keep their steering snapshot.</span>}
      {nameError && <span className="neg" role="alert">{nameError}</span>}
      {status && <span className={`${cx.line} ${status.tone}`} role="status">{status.text}{status.fleet && <> · <Link href="/fleet">View in Fleet</Link></>}</span>}
    </div>
  );
}

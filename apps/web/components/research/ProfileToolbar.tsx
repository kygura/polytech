import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Panel } from "../ui";
import cx from "../../app/(app)/research/research.module.css";

export type Status = { tone: "up" | "warn" | "down" | "muted"; text: string; fleet?: boolean } | null;

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
    <Panel pad label="profile" className={cx.toolbar}>
      <div className={cx.tb}>
      <div className={cx.tools} role="toolbar" aria-label="profile actions">
        <input className={cx.name} aria-label="profile name" aria-invalid={!!nameError} placeholder="profile name" maxLength={80} value={name} onChange={(e) => onName(e.target.value)} />
        {dirty && <><span className="warn" title="unsaved changes">{"•"}</span><span className="muted">unsaved</span></>}
        <label className={cx.check}><input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />enabled</label>
        <span className={cx.spacer} />
        <Button onClick={onPreview} disabled={busy}>Preview matches <kbd>p</kbd></Button>
        <Button onClick={onRun} disabled={!canRun} title={runDisabled ? "Research is disabled on this server" : isNew || dirty ? "Save first — Run now uses the saved profile" : undefined}>Run now <kbd>x</kbd></Button>
        <Button variant="primary" onClick={onSave} disabled={!dirty || !!blocker || busy} title={blocker ?? undefined}>Save <kbd>Ctrl+Enter</kbd></Button>
        {!isNew && (confirm
          ? <>
              <span className="warn">Delete?</span>
              <Button variant="danger" onClick={() => { setConfirm(false); onDelete(); }}>Confirm</Button>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
            </>
          : <Button variant="danger" onClick={() => setConfirm(true)}>Delete</Button>)}
      </div>
      {confirm && <span className={`${cx.line} muted`}>Delete &lsquo;{name}&rsquo;? Past pods keep their steering snapshot.</span>}
      {nameError && <span className="down" role="alert">{nameError}</span>}
      {status && <span className={`${cx.line} ${status.tone}`} role="status">{status.text}{status.fleet && <> · <Link href="/runs">View in Runs</Link></>}</span>}
      </div>
    </Panel>
  );
}

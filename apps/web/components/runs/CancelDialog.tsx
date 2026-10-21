"use client";
import { useEffect, useRef } from "react";
import { Button } from "../ui";
import css from "./runs.module.css";

/** Native <dialog>; Esc keeps (browser cancel event), Enter lands on the autofocused confirm button. */
export function CancelDialog({ open, onKeep, onConfirm }: { open: boolean; onKeep: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={css.sheet} onClose={onKeep} aria-labelledby="cancel-title">
      <h2 id="cancel-title">Cancel run?</h2>
      <p>Agents that finished are kept; no thesis will be written.</p>
      <div className={css.btns}>
        <Button onClick={onKeep}>Keep <kbd>Esc</kbd></Button>
        <Button className={css.danger} autoFocus onClick={onConfirm}>Cancel run <kbd>Enter</kbd></Button>
      </div>
    </dialog>
  );
}

"use client";
import { useEffect, useRef, type ReactNode } from "react";
import css from "./ui.module.css";

/** Native <dialog>; Esc closes via the browser's cancel event. */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={css.drawer} onClose={onClose} onCancel={onClose} aria-label={title}>
      <div className={css.drawerHead}><span>{title}</span><button type="button" onClick={onClose} aria-label="close">{"×"}</button></div>
      <div className={css.drawerBody}>{children}</div>
    </dialog>
  );
}

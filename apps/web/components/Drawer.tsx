"use client";
import { useEffect, useRef, type ReactNode } from "react";
import css from "./ui.module.css";

/** Native <dialog>; Esc closes via the browser's cancel event. `className` restyles the dialog (right rail); `actions` sit in the head, left of the close button. */
export function Drawer({ open, title, onClose, children, className, actions }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={className ? `${css.drawer} ${className}` : css.drawer} onClose={onClose} onCancel={onClose} aria-label={title}>
      <div className={css.drawerHead}><span>{title}</span><span className={css.drawerActions}>{actions}<button type="button" onClick={onClose} aria-label="close">{"×"}</button></span></div>
      <div className={css.drawerBody}>{children}</div>
    </dialog>
  );
}

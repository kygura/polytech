"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui";
import { COL_LABEL, COLUMNS, DEFAULT_COLS } from "./columns";
import css from "./screener.module.css";
import type { SavedView } from "./types";

/** Close on outside pointerdown while open. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [open, close]);
  return ref;
}

export type ViewActions = { onPick: (id: string) => void; onSaveAs: () => void; onRename: () => void; onDelete: () => void; onRevert: () => void };

export function ViewMenu({ views, activeId, dirty, open, setOpen, ...act }: { views: SavedView[]; activeId: string; dirty: boolean; open: boolean; setOpen: (o: boolean) => void } & ViewActions) {
  const wrap = useOutside(open, () => setOpen(false));
  const menu = useRef<HTMLDivElement>(null);
  const name = activeId === "default" ? "Default" : (views.find((v) => v.id === activeId)?.name ?? "Default");
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus(); }, [open]);
  const run = (f: () => void) => () => { setOpen(false); f(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...menu.current!.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    e.preventDefault();
  };
  const radio = (id: string, label: string) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={id === activeId} className={css.item} onClick={run(() => act.onPick(id))}><span>{label}</span></button>
  );
  return (
    <div ref={wrap} className={css.viewWrap}>
      <button type="button" className={css.viewBtn} aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts="v" onClick={() => setOpen(!open)} title="Views (v)">
        <span className={css.viewName}>{name}{dirty && <span className={css.dirty} title="query differs from the saved view" aria-label="modified"> {"•"}</span>}</span>
        <span aria-hidden>{"▾"}</span>
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label="Views" className={css.menu} onKeyDown={onKey}>
          {radio("default", "Default")}
          {views.map((v) => radio(v.id, v.name))}
          <div className={css.sep} role="separator" />
          <button type="button" role="menuitem" className={css.item} onClick={run(act.onSaveAs)}><span>Save as…</span><span className={css.hotkey}>Ctrl+S</span></button>
          <button type="button" role="menuitem" className={css.item} disabled={activeId === "default"} onClick={run(act.onRename)}><span>Rename</span></button>
          <button type="button" role="menuitem" className={css.item} disabled={activeId === "default"} onClick={run(act.onDelete)}><span>Delete</span></button>
          <button type="button" role="menuitem" className={css.item} disabled={!dirty} onClick={run(act.onRevert)}><span>Revert</span></button>
        </div>
      )}
    </div>
  );
}

/** `[c] cols` button + the 256px picker: visible columns first (↑/↓ reorder), the rest below. */
export function ColsMenu({ cols, onChange, open, setOpen }: { cols: string[]; onChange: (c: string[] | null) => void; open: boolean; setOpen: (o: boolean) => void }) {
  const wrap = useOutside(open, () => setOpen(false));
  const hidden = COLUMNS.map((c) => c.id).filter((id) => !cols.includes(id));
  const move = (i: number, d: -1 | 1) => { const n = [...cols]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; onChange(n); };
  const row = (id: string, i: number) => {
    const on = i >= 0;
    return (
      <div key={id} className={css.colRow}>
        <label>
          <input type="checkbox" checked={on} disabled={on && cols.length === 1} onChange={() => onChange(on ? cols.filter((c) => c !== id) : [...cols, id])} />
          <span>{COL_LABEL.get(id)}</span>
        </label>
        {on && <>
          <button type="button" disabled={i === 0} aria-label={`Move ${COL_LABEL.get(id)} up`} onClick={() => move(i, -1)}>{"↑"}</button>
          <button type="button" disabled={i === cols.length - 1} aria-label={`Move ${COL_LABEL.get(id)} down`} onClick={() => move(i, 1)}>{"↓"}</button>
        </>}
      </div>
    );
  };
  return (
    <div ref={wrap} className={css.viewWrap}>
      <Button className={css.metaBtn} aria-haspopup="true" aria-expanded={open} aria-keyshortcuts="c" onClick={() => setOpen(!open)} title="Columns (c)">Cols <kbd aria-hidden>c</kbd></Button>
      {open && (
        <div role="group" aria-label="Columns" className={css.cols}>
          <div className={css.colsHead}><span>Columns</span><button type="button" onClick={() => onChange(null)} disabled={cols.join() === DEFAULT_COLS.join()}>Reset</button></div>
          {cols.map((id, i) => row(id, i))}
          {hidden.map((id) => row(id, -1))}
        </div>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={css.sheet} aria-label={title} onClose={onClose}><h2>{title}</h2>{children}</dialog>;
}

/** 360px dialog with one name field. `submit` resolves to an error message, or null when done. */
export function NameSheet({ title, initial, action, hint, submit, onClose }: { title: string; initial: string; action: string; hint?: (name: string) => string | null; submit: (name: string) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const m = await submit(name.trim());
    setBusy(false);
    if (m) setErr(m); else onClose();
  };
  const note = err ?? hint?.(name.trim());
  return (
    <Sheet title={title} onClose={onClose}>
      <form onSubmit={go}>
        <input type="text" value={name} maxLength={60} autoFocus aria-label="View name" onChange={(e) => { setName(e.target.value); setErr(null); }} />
        {note && <div className={err ? "neg" : "muted"} role={err ? "alert" : undefined}>{note}</div>}
        <div className={css.sheetActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{action}</Button>
        </div>
      </form>
    </Sheet>
  );
}

export function ConfirmSheet({ title, action, onConfirm, onClose }: { title: string; action: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className={css.sheetActions}>
        <Button autoFocus onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onConfirm(); onClose(); }}>{action}</Button>
      </div>
    </Sheet>
  );
}

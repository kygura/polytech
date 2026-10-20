"use client";
import type { DslError } from "@pm/core";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { acceptHint, applySuggestion, classify, errorAt, hintContext, hintItems, type Hint } from "./dsl";
import css from "./screener.module.css";

type Props = { value: string; onChange: (v: string) => void; errors: DslError[]; known: { tags: string[]; categories: string[] } };

/** Single-line DSL input over a `DslHighlighter` mirror, with the error line, suggestion chip and key/value hints. */
export function QueryBar({ value, onChange, errors, known }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const pending = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const listId = useId();

  const segs = useMemo(() => classify(value, errors), [value, errors]);
  const ctx = useMemo(() => (focus ? hintContext(value, caret) : null), [focus, value, caret]);
  const hints = useMemo(() => hintItems(ctx, known), [ctx, known]);
  const open = hints.length > 0 && !closed;
  const active = Math.min(sel, Math.max(0, hints.length - 1));
  const first = errors[0];
  const atErr = errorAt(errors, caret);

  // move the caret after a programmatic edit once React has written the new value
  useLayoutEffect(() => {
    const c = pending.current, el = ref.current;
    if (c == null || !el) return;
    pending.current = null;
    el.setSelectionRange(c, c);
    setCaret(c);
    setScrollLeft(el.scrollLeft);
  }, [value]);

  const edit = (r: { text: string; caret: number }) => { pending.current = r.caret; setClosed(false); onChange(r.text); };
  const accept = (h: Hint) => ctx && edit(acceptHint(value, ctx, h));
  const fix = (e: DslError | undefined) => { const r = e && applySuggestion(value, e); if (r) edit(r); return !!r; };
  const sync = (el: HTMLInputElement) => { setCaret(el.selectionStart ?? 0); setScrollLeft(el.scrollLeft); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { setSel((active + (e.key === "ArrowDown" ? 1 : hints.length - 1)) % hints.length); e.preventDefault(); }
      else if (e.key === "Tab" || e.key === "Enter") { accept(hints[active]!); e.preventDefault(); }
      else if (e.key === "Escape") { setClosed(true); e.stopPropagation(); } // second Esc reaches the global blur
    } else if (e.key === "Tab" && !e.shiftKey && fix(atErr)) e.preventDefault();
  };

  return (
    <div className={css.barWrap}>
      <div className={css.qbox}>
        <div className={css.mirror} aria-hidden>
          <span style={{ transform: `translateX(${-scrollLeft}px)` }}>
            {segs.map((s, i) => <span key={i} className={`${s.cls === "ws" ? "" : css[s.cls]} ${s.err ? css.err : ""}`}>{s.text}</span>)}
          </span>
        </div>
        <input
          ref={ref}
          className={css.qinput}
          data-filter
          type="text"
          role="combobox"
          aria-label="Query"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          aria-invalid={errors.length > 0}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="liq:5k..50k cat:politics -is:muted sort:-prio"
          value={value}
          onChange={(e) => { setClosed(false); setSel(0); onChange(e.target.value); sync(e.target); }}
          onSelect={(e) => sync(e.currentTarget)}
          onKeyUp={(e) => sync(e.currentTarget)}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onFocus={(e) => { setFocus(true); sync(e.currentTarget); }}
          onBlur={() => setFocus(false)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (
        <ul id={listId} role="listbox" aria-label="Query hints" className={css.hints}>
          {hints.map((h, i) => (
            <li key={h.label} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={css.hint}
              onMouseDown={(e) => { e.preventDefault(); accept(h); }} onMouseEnter={() => setSel(i)}>
              <span className={h.kind === "key" ? css.hKey : css.val}>{h.label}</span>
              {h.example && <span className={css.hEx}>{h.example}</span>}
              {h.description && <span className={css.hDesc}>{h.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {first && !open && (
        <div className={css.errLine} role="alert">
          <span>{"⚠"} col {(first.col ?? 0) + 1}: {first.message}</span>
          {first.suggestion && <button type="button" className={css.cap} title="replace (Tab)" onMouseDown={(e) => e.preventDefault()} onClick={() => { fix(first); ref.current?.focus(); }}>{first.suggestion}</button>}
          {errors.length > 1 && <span className={css.errMore}>{" · "}+{errors.length - 1} more</span>}
        </div>
      )}
    </div>
  );
}

"use client";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { alertHref, kindOf, listKey, type Alert } from "./alerts";
import { EdgeBadge } from "./EdgeBadge";
import { EmptyState } from "./EmptyState";
import { hm } from "./fmt";
import css from "./alerts.module.css";

/** Alert rows (DESIGN 12.5), shared by the drawer and the Watchlist tab. Keys j/k/Enter/a/A act while the list has focus. `onOpen` is called for click/Enter and must ack + navigate. */
export function AlertsList({ rows, emptyText = "No alerts.", onAck, onAckAll, onOpen, listRef }: {
  rows: Alert[]; emptyText?: string; onAck: (id: number) => void; onAckAll: () => void; onOpen: (a: Alert) => void; listRef?: RefObject<HTMLUListElement | null>;
}) {
  const [sel, setSel] = useState(0);
  const own = useRef<HTMLUListElement>(null);
  const ref = listRef ?? own;
  const cur = Math.min(sel, Math.max(0, rows.length - 1));
  useEffect(() => { ref.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView?.({ block: "nearest" }); }, [cur, ref]);
  if (!rows.length) return <EmptyState text={emptyText} />;
  const firstAcked = rows.findIndex((_, i) => rows.slice(i).every((a) => a.ackedAt != null));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return; // a focused [ack] button keeps its own Enter
    const r = listKey(e.key, cur, rows.length);
    if (!r) return;
    e.preventDefault();
    setSel(r.sel);
    const a = rows[r.sel]!;
    if (r.act === "open") onOpen(a);
    else if (r.act === "ack" && a.ackedAt == null) onAck(a.id);
    else if (r.act === "ackAll") onAckAll();
  };
  return (
    <ul ref={ref} className={css.list} role="listbox" tabIndex={0} aria-label="alerts" aria-activedescendant={`alert-${rows[cur]!.id}`} onKeyDown={onKey}>
      {rows.map((a, i) => (
        <Fragment key={a.id}>
          {i === firstAcked && i > 0 && <li role="separator" className={css.divider}>acked</li>}
          <AlertItem a={a} selected={i === cur} onSelect={() => setSel(i)} onOpen={() => onOpen(a)} onAck={() => onAck(a.id)} />
        </Fragment>
      ))}
    </ul>
  );
}

function AlertItem({ a, selected, onSelect, onOpen, onAck }: { a: Alert; selected: boolean; onSelect: () => void; onOpen: () => void; onAck: () => void }) {
  const k = kindOf(a.kind);
  const unacked = a.ackedAt == null;
  const delta = a.kind === "mid_move" && typeof a.data?.deltaC === "number" ? a.data.deltaC : null;
  return (
    <li id={`alert-${a.id}`} role="option" aria-selected={selected} className={`${css.item} ${unacked ? css.unacked : css.acked}`}
      onMouseEnter={onSelect} onClick={onOpen} title={alertHref(a) ? "open" : undefined}>
      <span className={css.state} role="img" aria-label={unacked ? "unacknowledged" : "acknowledged"}>{unacked ? "●" : "○"}</span>
      <span className={css.body}>
        <span className={css.l1}>
          <span className={css.time}>{a.createdAt != null ? hm(a.createdAt) : "—"}</span>
          <span style={{ color: k.tone }} aria-hidden>{k.glyph}</span>
          <span>{k.label}</span>
          {delta != null && <EdgeBadge cents={delta} />}
        </span>
        <span className={css.l2} title={a.message}>{a.message}</span>
        {a.question && <span className={css.l3} title={a.question}>{a.question}</span>}
      </span>
      {unacked && <button type="button" className={css.ackBtn} onClick={(e) => { e.stopPropagation(); onAck(); }} aria-label={`acknowledge: ${a.message}`}>ack</button>}
    </li>
  );
}

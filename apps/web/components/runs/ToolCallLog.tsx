"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { hms, truncate } from "../fmt";
import { atBottom, tailStep } from "./runs";
import css from "./runs.module.css";

export type ToolCall = { ts: number; name: string; input: string; ok: boolean };

/** Chronological tool calls. Autoscrolls only while the reader sits at the bottom; otherwise a "↓ N new" chip. */
export function ToolCallLog({ calls }: { calls: ToolCall[] }) {
  const el = useRef<HTMLUListElement>(null);
  const stuck = useRef(true); // at bottom as of the last scroll event (before new rows render)
  const tail = useRef({ count: 0, unseen: 0 });
  const [unseen, setUnseen] = useState(0);

  useLayoutEffect(() => {
    const next = tailStep(tail.current, calls.length, stuck.current);
    tail.current = next;
    setUnseen(next.unseen);
    if (next.scroll && el.current) el.current.scrollTop = el.current.scrollHeight;
  }, [calls.length]);

  const down = () => { const e = el.current; if (!e) return; e.scrollTop = e.scrollHeight; stuck.current = true; tail.current = { ...tail.current, unseen: 0 }; setUnseen(0); };
  const onScroll = () => {
    const e = el.current!;
    stuck.current = atBottom(e.scrollTop, e.clientHeight, e.scrollHeight);
    if (stuck.current && tail.current.unseen) { tail.current = { ...tail.current, unseen: 0 }; setUnseen(0); }
  };

  if (!calls.length) return <p className="muted" style={{ margin: 0 }}>No tool calls recorded.</p>;
  return (
    <div className={css.logWrap}>
      <ul ref={el} className={css.log} onScroll={onScroll} aria-label="tool calls" tabIndex={0}>
        {calls.map((c, i) => (
          <li key={i} title={c.input}>
            <span className={css.t}>{hms(c.ts)}</span><span className={css.n}>{c.name}</span>{truncate(c.input, 160)}
            {!c.ok && <span className="neg"> {"→"} error</span>}
          </li>
        ))}
      </ul>
      {unseen > 0 && <button type="button" className={css.chip} onClick={down}>{"↓"} {unseen} new</button>}
    </div>
  );
}

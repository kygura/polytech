"use client";
import { useEffect, useState } from "react";
import { TRIAGE_RULES } from "../../../lib/triageRules";
import { Button, Panel } from "../../ui";
import cx from "./desk.module.css";

const KEY = "pm.research.how";

/** Collapsible three-step explainer; open until the viewer closes it once. */
export function HowItWorks() {
  const [open, setOpen] = useState(true);
  useEffect(() => { try { if (localStorage.getItem(KEY) === "0") setOpen(false); } catch {} }, []);
  const toggle = () => { setOpen((o) => { try { localStorage.setItem(KEY, o ? "0" : "1"); } catch {} return !o; }); };
  return (
    <Panel title="How it works" label="how it works" pad={open} right={<Button size="sm" variant="ghost" aria-expanded={open} onClick={toggle}>{open ? "Hide" : "Show"}</Button>}>
      {open && (
        <ol className={cx.how}>
          <li>
            <b>Rules.</b> Each market is checked against fixed rules first, no model involved. Failing any one means skip:
            <ul>{Object.values(TRIAGE_RULES).map((t) => <li key={t}>{t}</li>)}</ul>
          </li>
          <li><b>Quick check.</b> A cheap model (Haiku) reads the question and its resolution rules, never the price, and says research or skip with a 0–1 score. Verdicts are kept for 24 hours.</li>
          <li><b>Research run.</b> Five analysts (rules reader, primary sources, base rates, news, red team) search the web, then a judge sets a fair value. Edge is fair value minus price. About 3 minutes and $0.20–0.50 per run.</li>
        </ol>
      )}
    </Panel>
  );
}

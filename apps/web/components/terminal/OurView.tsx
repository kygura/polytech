"use client";
// "Our view" strip (center pane, under the market header): our fair value vs the market, the edge, the suggested stake, or where research stands.
import type { ReactNode } from "react";
import { ago } from "../fmt";
import { Button } from "../ui";
import { cents, usd, type Outcome } from "./book";
import { clock, edgeNow, failText, MIN_EDGE_C, type ViewState } from "./research";
import css from "./terminal.module.css";

const TIP = {
  fair: "Fair value: what our research thinks YES is worth, in cents per $1 share.",
  market: "Market: what YES trades at on Polymarket now.",
  edge: "Edge: fair value minus the price you would pay, after fees. Positive means the share looks cheap.",
  size: "Suggested: a Kelly-sized stake (bet more when the edge and confidence are bigger) within your risk limits.",
};
const STEP: Record<string, string> = { rules: "reading the rules", judge: "the judge is setting a fair value", sizing: "sizing the trade" };

type Props = {
  state: ViewState | null;
  /** YES display price now. */
  yes: number | null;
  /** Best ask per outcome now (what one share costs). */
  ask: (o: Outcome) => number | null;
  feeRate: number; feeExp: number; tick: number; now: number;
  disabled: boolean; starting: boolean; startErr: string | null;
  onResearch: () => void; onCancel: (podId: string) => void; cancelling: boolean;
  onBuy: (side: Outcome, usd: number | null) => void;
};

export function OurView(p: Props) {
  const c = (v: number | null) => (v == null ? "—" : `${cents(v, p.tick)}¢`);
  const s = p.state;
  const again = (label = "Research again") => !p.disabled && (
    <Button variant="ghost" size="sm" onClick={p.onResearch} disabled={p.starting} title="Run the AI analysts again on today's rules, news and price (r)">{p.starting ? "Starting…" : label}<kbd>r</kbd></Button>
  );
  let body: ReactNode, sub: ReactNode = null;
  if (!s) body = <span className={css.dim}>Loading our view…</span>;
  else if (s.k === "running") {
    const step = s.stage === "agents" || !s.stage ? (s.total ? `${s.done}/${s.total} analysts done` : "starting") : STEP[s.stage] ?? s.stage;
    body = <>
      <span className={css.ovLbl}>Researching {"·"} {step} {"·"} <span className={css.n}>{clock((p.now - s.startedAt) / 1000)}</span></span>
      <span className={css.prog} role="progressbar" aria-label="Research progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.pct}><i style={{ width: `${s.pct}%` }} /></span>
      {s.podId && <Button variant="ghost" size="sm" onClick={() => p.onCancel(s.podId!)} disabled={p.cancelling} title="Stop this research run. Analysts that already finished are still paid for.">{p.cancelling ? "Cancelling…" : "Cancel"}</Button>}
    </>;
    sub = "5 AI analysts read the rules and sources, then a judge sets a fair value. Takes about 3 minutes.";
  } else if (s.k === "failed") {
    body = <>
      <span className={css.down} title={s.error ?? "no error recorded"}>Research failed: {failText(s.error)}</span>
      {again("Retry")}
    </>;
  } else if (s.k === "cancelled") {
    body = <><span className={css.dim}>Research was cancelled.</span>{again("Research")}</>;
  } else if (s.k === "none") {
    body = p.disabled ? <span className={css.dim}>Not researched yet. Research is off on this server: ANTHROPIC_API_KEY is not set.</span>
      : <><span>Not researched yet</span><Button variant="primary" size="sm" onClick={p.onResearch} disabled={p.starting}>{p.starting ? "Starting…" : "Research"}<kbd>r</kbd></Button></>;
    if (!p.disabled) sub = "5 AI analysts read the rules and sources, then a judge sets a fair value (~3 min).";
  } else if (s.k === "judge" || s.sizeUsd < 1) {
    // researched, nothing sized: a pass. The gap is shown neutral, never as a green "edge".
    const close = p.yes != null && Math.abs(s.pYes - p.yes) < 0.03;
    body = <>
      <span title={TIP.fair}>Fair value <b className={css.n}>{c(s.pYes)}</b></span>
      <span className={css.dim}>{close ? "≈" : "·"}</span>
      <span title={TIP.market}>Market <b className={css.n}>{c(p.yes)}</b></span>
      <span className={css.dim}>{close ? "— fairly priced, no edge worth trading" : "— no trade: the gap does not survive fees and our confidence"}</span>
      <span className={css.dim} title={new Date(s.at).toLocaleString()}>researched {ago(p.now - s.at)}</span>
      {again()}
    </>;
  } else {
    const side = s.side, live = edgeNow(s.pYes, side, p.ask(side), p.feeRate, p.feeExp);
    const edge = live ?? s.edgeC, gone = edge < MIN_EDGE_C;
    const fairSide = side === "YES" ? s.pYes : 1 - s.pYes, ask = p.ask(side);
    body = <>
      <span title={TIP.fair}>Fair value <b className={css.n}>{c(s.pYes)}</b></span>
      <span className={css.dim}>{"·"}</span>
      <span title={TIP.market}>Market <b className={css.n}>{c(p.yes)}</b></span>
      <span className={css.dim}>{"·"}</span>
      <span title={`${TIP.edge}${side === "NO" ? ` Here: NO is worth ${c(fairSide)}, costs ${c(ask)}.` : ""}${live == null ? " (from the research; no live price)" : ""}`}>
        Edge <b className={`${css.n} ${edge >= 0 ? css.up : css.down}`}>{edge >= 0 ? "+" : "−"}{Math.abs(edge).toFixed(1).replace(/\.0$/, "")}¢</b> on <span className={side === "YES" ? css.yes : css.no}>{side}</span>
      </span>
      {!gone && s.sizeUsd >= 1 && <><span className={css.dim}>{"·"}</span><span title={TIP.size}>Suggested <b className={css.n}>{usd(s.sizeUsd).replace(/\.00$/, "")}</b></span></>}
      {gone ? <span className={css.dim}>— the price moved; no edge at this price</span>
        : <Button variant="primary" size="sm" onClick={() => p.onBuy(side, s.sizeUsd >= 1 ? s.sizeUsd : null)} title={`Fill the ticket: buy ${side}${s.sizeUsd >= 1 ? `, ${usd(s.sizeUsd)}` : ""}. You still review and place it.`}>Buy {side}</Button>}
      <span className={css.dim} title={new Date(s.at).toLocaleString()}>researched {ago(p.now - s.at)}</span>
      {again()}
    </>;
  }
  return (
    <div className={css.ov} aria-label="Our view" role="group">
      <div className={css.ovRow}><span className={css.ovTitle}>Our view</span>{body}</div>
      {p.startErr && <div className={`${css.ovSub} ${css.down}`} role="alert">{p.startErr}</div>}
      {sub && !p.startErr && <div className={css.ovSub}>{sub}</div>}
    </div>
  );
}

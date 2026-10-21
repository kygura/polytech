"use client";
import type { ReactNode } from "react";
import { MeterBar } from "./MeterBar";
import { fmt } from "./fmt";
import type { SettingsForm } from "./SettingsForm";
import { Panel, Table } from "./ui";
import css from "./autonomy.module.css";

export type Limits = { perTradeUsd: number; perTradePct: number; perMarket: number; perEvent: number; perCategory: number; totalOpen: number; dailyNotional: number; dailyLoss: number };
export type Usage = { totalOpen: number; dailyNotional: number; dailyRealizedLoss: number; byCategory: Record<string, number> };
export const LIMIT_PATHS = ["perTradeUsd", "perTradePct", "perMarket", "perEvent", "perCategory", "totalOpen", "dailyNotional", "dailyLoss"].map((k) => `limits.${k}`);

/** Editable caps (saved through PUT /api/settings) with what each one is using now. Rows the exposure read does not report show used as —. */
export function RiskLimits({ form: f, usage: u }: { form: SettingsForm; usage: Usage }) {
  const l = f.s.limits, B = f.s.bankroll;
  const cats = Object.entries(u.byCategory);
  const topCat = cats.length ? cats.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const usd = (v: number) => (Number.isFinite(v) ? `$${fmt(v, "usd")}` : "—");
  const rows: [key: keyof Limits, name: string, hint: ReactNode, used: number | null, unit: string, scale?: number][] = [
    ["perTradeUsd", "Per trade", "Largest single order. 50 = no order above $50.", null, "USD"],
    ["perTradePct", "Per trade, share of bankroll", <>The same cap as a share of bankroll B. Now {usd(l.perTradePct * B)} at B {usd(B)}. Typical 5.</>, null, "% of B", 100],
    ["perMarket", "Per market", "Most held in one market. Typical 100.", null, "USD"],
    ["perEvent", "Per event", "Most held across the markets of one event; a neg-risk group counts as one event. Typical 100.", null, "USD"],
    ["perCategory", "Per category", <>Most held in one category such as sports or politics.{topCat && <> Largest now: {topCat[0]}.</>} Typical 300.</>, topCat?.[1] ?? null, "USD"],
    ["totalOpen", "Total open", "All open positions together. Typical 500.", u.totalOpen, "USD"],
    ["dailyNotional", "Daily orders", "Dollars sent in orders per day (UTC). Typical 500.", u.dailyNotional, "USD"],
    ["dailyLoss", "Daily loss", "Realized loss in a day that drops the mode to L0 and blocks new orders. 0 turns the drop off. Typical 100.", u.dailyRealizedLoss, "USD"],
  ];
  return (
    <Panel title={<span>Risk limits{f.dirty(LIMIT_PATHS) && <span className="warn" title="unsaved changes"> {"•"}</span>}</span>} label="Risk limits" right={f.saveButton("Risk limits", LIMIT_PATHS)}>
      <p className={css.intro}>Hard caps on every real order the system sends (L2 to L4). At L1 a paper fill that breaks one is kept and flagged, not blocked. Usage is from the paper book.</p>
      <Table label="risk limits" className={css.limits}>
        <thead><tr><th scope="col">Limit</th><th scope="col" className="num">Cap</th><th scope="col" className="num" title="Paper book: open positions, and today's orders and realized loss">In use</th><th scope="col" className={css.meterCell} aria-label="usage bar" /></tr></thead>
        <tbody>
          {rows.map(([k, name, hint, used, unit, scale]) => {
            const cap = l[k] * (k === "perTradePct" ? B : 1);
            return (
              <tr key={k}>
                <td><span className={css.name}>{name}</span><span className={css.hint} id={`limits.${k}-h`}>{hint}</span></td>
                <td className="num">{f.numCell(`limits.${k}`, name, { unit, scale, hint })}</td>
                <td className="num">{used == null ? <span className="muted">{"—"}</span> : usd(used)}</td>
                <td className={css.meterCell}>{used == null ? null : <MeterBar value={used} max={cap} />}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

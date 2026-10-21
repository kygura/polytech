"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { MeterBar } from "./MeterBar";
import { fmt } from "./fmt";
import ui from "./ui/ui.module.css";
import css from "./page.module.css";

/** Table (DataTable) inside a Panel body: drops the table's own border so the Panel is the only frame. */
export const Flat = ({ children }: { children: ReactNode }) => <div className={css.flat}>{children}</div>;

/** Market question for a list row (DESIGN 13.6): links to /trade/[id], wraps to two lines inside `.row2` rows, full question (and category) in the tooltip. */
export function MarketTitle({ id, question, category, newTab }: { id: string; question: string; category?: string | null; newTab?: boolean }) {
  return (
    <Link href={`/trade/${encodeURIComponent(id)}`} className={`q ${css.title}`} title={category ? `${question}\n${category}` : question} onClick={(e) => e.stopPropagation()} {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}>
      {question}
    </Link>
  );
}

export type Kpi = { label: ReactNode; value: ReactNode; meter?: { value: number; max: number }; note?: boolean };

/** KPI strip: muted label over a mono `--fs-xl` value, optional meter under it. Lives in a Panel. */
export function Kpis({ items, label }: { items: Kpi[]; label: string }) {
  return (
    <dl className={css.kpis} aria-label={label}>
      {items.map((k, i) => (
        <div key={i} className={k.note ? `${css.kpi} ${css.note}` : css.kpi}>
          <dt>{k.label}</dt>
          <dd>{k.value}</dd>
          {k.meter && <MeterBar value={k.meter.value} max={k.meter.max} />}
        </div>
      ))}
    </dl>
  );
}

/** Link styled as a secondary Button (server pages can't pass onClick to Button). */
export const LinkButton = ({ href, children }: { href: string; children: ReactNode }) => <Link href={href} className={ui.btn}>{children}</Link>;

/** Signed dollars, sign before the `$`: `+$12`, `−$3`, `$0`. Coloured up/down by sign. */
export function Money({ value }: { value: number | null | undefined }) {
  if (value == null || Number.isNaN(value)) return <span className="muted">{"—"}</span>;
  if (value === 0) return <span className="muted">$0</span>;
  return <span className={value > 0 ? "up" : "down"}>{`${value < 0 ? "−" : "+"}$${fmt(Math.abs(value), "usd")}`}</span>;
}

/** Market title with trailing chips on one row (two-line title, chips beside it). */
export const MarketCell = ({ children }: { children: ReactNode }) => <span className={css.mcell}>{children}</span>;

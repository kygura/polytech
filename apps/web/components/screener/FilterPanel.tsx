"use client";
import type { Filter } from "@pm/core";
import { useId, useState, type ReactNode } from "react";
import { addChip, fmtBound, parseBound, removeChip, setBound, toggleValue, triGet, triSet, type FlagField, type ListField, type RangeField, type TagKind, type Tri } from "./filter";
import { Panel } from "../ui";
import css from "./screener.module.css";

type Edit = (f: Filter) => void;

function RangeRow({ f, field, label, onEdit }: { f: Filter; field: RangeField; label: string; onEdit: Edit }) {
  const [bad, setBad] = useState<"min" | "max" | null>(null);
  const commit = (which: "min" | "max", text: string) => {
    const v = parseBound(field, text);
    const next = v === null ? null : setBound(f, field, which, v);
    if (!next) return setBad(which);
    setBad(null);
    if (next !== f) onEdit(next);
  };
  const input = (which: "min" | "max") => {
    const v = f[field]?.[which];
    return (
      <input key={`${which}:${fmtBound(v)}`} className={css.rangeIn} defaultValue={fmtBound(v)} placeholder={which} inputMode="decimal" spellCheck={false}
        aria-label={`${label} ${which}`} aria-invalid={bad === which}
        onBlur={(e) => commit(which, e.target.value)} onKeyDown={(e) => e.key === "Enter" && commit(which, e.currentTarget.value)} />
    );
  };
  return <div className={css.rangeRow}><span>{label}</span>{input("min")}<span aria-hidden>..</span>{input("max")}</div>;
}

function Checks<F extends ListField>({ f, field, options, onEdit }: { f: Filter; field: F; options: [NonNullable<Filter[F]>[number], string][]; onEdit: Edit }) {
  return <>{options.map(([v, label]) => (
    <label key={v} className={css.check}><input type="checkbox" checked={(f[field] as string[] | undefined)?.includes(v) ?? false} onChange={() => onEdit(toggleValue(f, field, v))} />{label}</label>
  ))}</>;
}

function TriRow({ f, field, label, onEdit }: { f: Filter; field: FlagField; label: string; onEdit: Edit }) {
  const name = useId(), cur = triGet(f, field);
  return (
    <div className={css.tri} role="radiogroup" aria-label={label}>
      <span>{label}</span>
      {(["any", "yes", "no"] as Tri[]).map((t) => <label key={t}><input type="radio" name={name} checked={cur === t} onChange={() => onEdit(triSet(f, field, t))} />{t}</label>)}
    </div>
  );
}

function TagInput({ f, kind, label, known, onEdit }: { f: Filter; kind: TagKind; label: string; known: string[]; onEdit: Edit }) {
  const [draft, setDraft] = useState("");
  const list = useId();
  const inc = f[kind] ?? [], exc = f[kind === "tags" ? "excludeTags" : "excludeCategories"] ?? [];
  const chip = (v: string, exclude: boolean) => (
    <span key={(exclude ? "-" : "") + v} className={`${css.chip} ${exclude ? css.chipNeg : ""}`}>
      {exclude ? `−${v}` : v}
      <button type="button" aria-label={`remove ${v}`} onClick={() => onEdit(removeChip(f, kind, v, exclude))}>{"×"}</button>
    </span>
  );
  return (
    <div>
      <input className={css.tagIn} list={list} value={draft} placeholder={`${label} (- excludes)`} aria-label={label} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onEdit(addChip(f, kind, draft)); setDraft(""); } }} />
      <datalist id={list}>{known.slice(0, 50).map((k) => <option key={k} value={k} />)}</datalist>
      {(inc.length > 0 || exc.length > 0) && <div className={css.chips}>{inc.map((v) => chip(v, false))}{exc.map((v) => chip(v, true))}</div>}
    </div>
  );
}

function Section({ title, disabled, children }: { title: string; disabled: boolean; children: ReactNode }) {
  return <details className={css.sec} open><summary>{title}</summary><fieldset className={css.secBody} disabled={disabled}>{children}</fieldset></details>;
}

/** Left rail. Holds no state: every control edits the `Filter`, the caller turns it into bar text with `formatQuery`. */
export function FilterPanel({ filter: f, disabled, onEdit, onClose, known }: { filter: Filter; disabled: boolean; onEdit: Edit; onClose: () => void; known: { tags: string[]; categories: string[] } }) {
  const R = (field: RangeField, label: string) => <RangeRow f={f} field={field} label={label} onEdit={onEdit} />;
  return (
    <Panel as="aside" className={css.filters} title="Filters" right={<button type="button" className={css.hideBtn} onClick={onClose} aria-label="Hide filters" title="Hide filters (f)">{"‹"}</button>}>
      {disabled && <div className={css.panelNote} role="status">query has errors</div>}
      <Section title="Liquidity & volume" disabled={disabled}>{R("liquidity", "liq")}{R("volume24h", "vol24h")}</Section>
      <Section title="Book" disabled={disabled}>{R("depth2c", "depth")}{R("spread", "spread")}{R("price", "price")}</Section>
      <Section title="Time" disabled={disabled}>{R("daysToResolution", "days")}{R("stalenessHours", "stale")}</Section>
      <Section title="Crowd" disabled={disabled}>{R("holderTop1Share", "top1")}{R("holderCount", "holders")}</Section>
      <Section title="Resolution" disabled={disabled}>
        <Checks f={f} field="resolutionSource" onEdit={onEdit} options={[["official_data", "official data"], ["scheduled_event", "scheduled event"], ["media_report", "media report"], ["subjective", "subjective"], ["unknown", "unknown"]]} />
      </Section>
      <Section title="Structural" disabled={disabled}>
        <Checks f={f} field="structural" onEdit={onEdit} options={[["overround", "overround"], ["monotonicity_violation", "monotonicity"], ["sibling_inconsistency", "sibling"]]} />
      </Section>
      <Section title="Scores" disabled={disabled}>{R("priority", "prio")}{R("opportunity", "opp")}{R("edge", "edge")}</Section>
      <Section title="Flags" disabled={disabled}>
        <TriRow f={f} field="watchlisted" label="is:watch" onEdit={onEdit} />
        <TriRow f={f} field="pinned" label="is:pinned" onEdit={onEdit} />
        <TriRow f={f} field="muted" label="is:muted" onEdit={onEdit} />
        <TriRow f={f} field="hasThesis" label="has:thesis" onEdit={onEdit} />
      </Section>
      <Section title="Tags & category" disabled={disabled}>
        <TagInput f={f} kind="tags" label="tag" known={known.tags} onEdit={onEdit} />
        <TagInput f={f} kind="categories" label="cat" known={known.categories} onEdit={onEdit} />
      </Section>
    </Panel>
  );
}

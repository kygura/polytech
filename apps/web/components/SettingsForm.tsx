"use client";
import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";
import type { AppSettings } from "../lib/jobs/settings";
import { Field } from "./Field";
import { FormGroup } from "./FormGroup";
import { copyPaths, getAt, issueMap, pickPaths, samePaths, setAt } from "./settingsPaths";
import { Button } from "./ui";
import css from "./SettingsForm.module.css";
import ui from "./ui.module.css";

const round = (v: number) => +v.toPrecision(12);
type NumOpts = { unit?: string; scale?: number; hint?: ReactNode; step?: number };

/** One AppSettings draft with per-group save (PUT /api/settings deep-merges the group's paths). Settings and Autonomy both edit through it. Field renderers are plain functions, not components: inputs keep focus across re-renders. */
export function useSettingsForm(initial: AppSettings) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [s, setS] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const set = (path: string, v: unknown) => setS((x) => setAt(x, path, v));
  const dirty = (paths: readonly string[]) => !samePaths(s, saved, paths);

  const save = async (paths: readonly string[]) => {
    setMsg(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pickPaths(s, paths)) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r?.status === 400 && Array.isArray(j.issues)) { setErrors(issueMap(j.issues)); return; }
    if (!r?.ok) { setMsg(`Save failed: ${j.error ?? r?.status ?? "network error"}`); return; }
    setErrors({}); setSaved(j); setS((x) => copyPaths(x, j, paths)); router.refresh();
  };

  const hintId = (path: string) => `${path}-h`;
  const hint = (path: string, h?: ReactNode) => h && <span id={hintId(path)} className={css.hint}>{h}</span>;
  const numValue = (path: string, scale: number) => { const v = getAt(s, path); return typeof v === "number" && Number.isFinite(v) ? round(v * scale) : ""; };
  const numEl = (path: string, scale: number, h: ReactNode, step?: number, label?: string) => (
    <input id={path} type="number" step={step ?? "any"} min={0} value={numValue(path, scale)} aria-label={label} aria-describedby={h ? hintId(path) : undefined} aria-invalid={errors[path] ? true : undefined}
      onChange={(e) => set(path, e.target.value === "" ? NaN : round(e.target.valueAsNumber / scale))} />
  );

  /** Label | input + unit, then the error and hint lines (FormGroup grid). */
  const num = (path: string, label: string, { unit, scale = 1, hint: h, step }: NumOpts = {}) => (
    <Fragment key={path}>
      <Field label={label} unit={unit} error={errors[path]} htmlFor={path}>{numEl(path, scale, h, step)}</Field>
      {hint(path, h)}
    </Fragment>
  );
  /** Bare input + unit + error, for a table cell (the row's first cell is the label). */
  const numCell = (path: string, label: string, { unit, scale = 1, hint: h, step }: NumOpts = {}) => (
    <span className={css.cell}>
      <span className={ui.fieldInput}>{numEl(path, scale, h, step, label)}{unit && <span className={ui.unit}>{unit}</span>}</span>
      {errors[path] && <span className={css.err} role="alert">{errors[path]}</span>}
    </span>
  );
  const multi = (path: string, label: string, options: readonly string[], h?: ReactNode) => {
    const v = (getAt(s, path) as string[] | undefined) ?? [];
    const opts = [...new Set([...options, ...v])].sort();
    return (
      <Fragment key={path}>
        <Field label={label} error={errors[path]} htmlFor={path}>
          <select id={path} multiple size={Math.min(6, Math.max(2, opts.length))} value={v} aria-describedby={h ? hintId(path) : undefined} onChange={(e) => set(path, [...e.target.selectedOptions].map((o) => o.value))}>
            {opts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {hint(path, h)}
      </Fragment>
    );
  };
  const check = (path: string, label: string, h?: ReactNode) => (
    <Fragment key={path}>
      <Field label={label} error={errors[path]} htmlFor={path}>
        <input id={path} type="checkbox" checked={!!getAt(s, path)} aria-describedby={h ? hintId(path) : undefined} onChange={(e) => set(path, e.target.checked)} />
      </Field>
      {hint(path, h)}
    </Fragment>
  );
  const select = (path: string, label: string, options: readonly { value: string; label: string }[], placeholder: string, h?: ReactNode) => (
    <Fragment key={path}>
      <Field label={label} error={errors[path]} htmlFor={path}>
        <select id={path} value={(getAt(s, path) as string | undefined) ?? ""} aria-describedby={h ? hintId(path) : undefined} onChange={(e) => set(path, e.target.value)}>
          <option value="" disabled>{placeholder}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {hint(path, h)}
    </Fragment>
  );
  const saveButton = (title: string, paths: readonly string[]) => {
    const d = dirty(paths);
    return <Button size="sm" variant={d ? "primary" : "secondary"} disabled={!d} onClick={() => void save(paths)}>Save {title.toLowerCase()}</Button>;
  };
  /** FormGroup panel; `intro` is a one-line explanation above the fields. */
  const group = (title: string, paths: readonly string[], children: ReactNode, o: { id?: string; intro?: ReactNode; saveLabel?: string } = {}) => (
    <FormGroup key={title} id={o.id} title={title} dirty={dirty(paths)} onSave={() => void save(paths)} saveLabel={o.saveLabel}>
      {o.intro && <p className={css.intro}>{o.intro}</p>}
      {children}
    </FormGroup>
  );

  return { s, saved, setS, setSaved, set, errors, msg, setMsg, dirty, save, num, numCell, multi, check, select, saveButton, group, hint };
}
export type SettingsForm = ReturnType<typeof useSettingsForm>;

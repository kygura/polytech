"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ErrorBar } from "../../../components/ErrorBar";
import { Field } from "../../../components/Field";
import { refitConfirm, refitPayload } from "../../../components/refit";
import { SuggestedRefit } from "../../../components/SuggestedRefit";
import { FormGroup } from "../../../components/FormGroup";
import { useTheme, type Theme } from "../../../hooks/useTheme";
import type { AppSettings } from "../../../lib/jobs/settings";

const GROUPS = {
  Filters: ["filters"], Calibration: ["extremize"], Weights: ["sizeTargets", "tDecayDays", "cCoef", "crowdBonus"], "Bankroll & sizing": ["bankroll", "kelly", "capFrac", "minEdge"],
  "Models per role": ["models"], Budget: ["budget"], "Risk limits": ["limits"],
} as const;
type Group = keyof typeof GROUPS;
const ROLES = ["rules", "source", "base_rate", "news", "red_team", "judge"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const THEMES: Theme[] = ["dark", "light"];

const pick = (s: AppSettings, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (s as Record<string, unknown>)[k]]));
const getAt = (o: unknown, path: string): unknown => path.split(".").reduce<any>((x, k) => x?.[k], o);
const setAt = (o: AppSettings, path: string, v: unknown): AppSettings => {
  const n = structuredClone(o), ks = path.split(".");
  let c: any = n;
  for (const k of ks.slice(0, -1)) c = c[k] ??= {};
  c[ks[ks.length - 1]!] = v;
  return n;
};
const round = (v: number) => +v.toPrecision(12);

export function SettingsView({ initial, categories }: { initial: AppSettings; categories: string[] }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [saved, setSaved] = useState(initial);
  const [s, setS] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [refitBusy, setRefitBusy] = useState(false);
  const set = (path: string, v: unknown) => setS((x) => setAt(x, path, v));
  const dirty = (g: Group) => JSON.stringify(pick(s, GROUPS[g])) !== JSON.stringify(pick(saved, GROUPS[g]));

  const save = async (g: Group) => {
    setMsg(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pick(s, GROUPS[g])) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 400 && Array.isArray(j.issues)) { setErrors(Object.fromEntries(j.issues.map((i: { path: (string | number)[]; message: string }) => [i.path.join("."), i.message]))); return; }
    if (!r.ok) { setMsg(`Save failed: ${j.error ?? r.status}`); return; }
    setErrors({}); setSaved(j); setS((x) => ({ ...x, ...pick(j, GROUPS[g]) })); router.refresh();
  };

  // Apply / Dismiss write on their own (not through the group's Save): extremize and/or suggested only; other unsaved edits stay in `s`.
  const refit = async (mode: "apply" | "dismiss") => {
    const sug = s.suggested;
    if (!sug || (mode === "apply" && !window.confirm(refitConfirm(sug)))) return;
    setMsg(null); setRefitBusy(true);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(refitPayload(mode, sug)) });
    const j = await r.json().catch(() => ({}));
    setRefitBusy(false);
    if (!r.ok) { setMsg(`${mode === "apply" ? "Apply" : "Dismiss"} failed: ${j.error ?? r.status}`); return; }
    setSaved((x) => ({ ...x, extremize: j.extremize, suggested: null })); setS((x) => ({ ...x, extremize: j.extremize, suggested: null })); router.refresh();
  };

  // Plain functions, not components: inputs keep focus across re-renders.
  const num = (path: string, label: string, unit?: string, scale = 1) => {
    const v = getAt(s, path);
    return (
      <Field key={path} label={label} unit={unit} error={errors[path]} htmlFor={path}>
        <input id={path} type="number" step="any" value={typeof v === "number" && Number.isFinite(v) ? round(v * scale) : ""}
          onChange={(e) => set(path, e.target.value === "" ? NaN : round(e.target.valueAsNumber / scale))} />
      </Field>
    );
  };
  const multi = (path: string, label: string) => {
    const v = (getAt(s, path) as string[] | undefined) ?? [];
    const opts = [...new Set([...categories, ...v])].sort();
    return (
      <Field key={path} label={label} error={errors[path]} htmlFor={path}>
        <select id={path} multiple size={Math.min(6, Math.max(2, opts.length))} value={v} onChange={(e) => set(path, [...e.target.selectedOptions].map((o) => o.value))}>
          {opts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
    );
  };
  const group = (g: Group, children: ReactNode) => <FormGroup key={g} id={g === "Calibration" || g === "Budget" ? g.toLowerCase() : undefined} title={g} dirty={dirty(g)} onSave={() => save(g)}>{children}</FormGroup>;

  return (
    <>
      {msg && <ErrorBar message={msg} onRetry={() => setMsg(null)} />}
      {group("Filters", <>
        {num("filters.minDays", "min days", "d")}{num("filters.maxDays", "max days", "d")}
        {num("filters.minDepthUsd", `min depth ${s.filters.depthCents}¢`, "USD")}
        {multi("filters.excludedCategories", "excluded categories")}
      </>)}
      {group("Calibration", <>
        {s.suggested && <SuggestedRefit current={saved.extremize} suggested={s.suggested} dirty={dirty("Calibration")} busy={refitBusy} onApply={() => void refit("apply")} onDismiss={() => void refit("dismiss")} />}
        {num("extremize", "extremize", "×")}
      </>)}
      {group("Weights", <>
        {num("sizeTargets.smallCap", "small-cap target", "USD")}{num("sizeTargets.size", "size target", "USD")}
        {num("tDecayDays", "T decay", "days")}{num("cCoef", "C weight")}{num("crowdBonus", "C_against weight")}
      </>)}
      {group("Bankroll & sizing", <>
        {num("bankroll", "bankroll B", "USD")}{num("kelly", "Kelly fraction")}{num("capFrac", "per-trade cap", "×B")}{num("minEdge", "min edge", "¢", 100)}
      </>)}
      {group("Models per role", ROLES.map((role) => (
        <Field key={role} label={role} error={errors[`models.${role}`]} htmlFor={`models.${role}`}>
          <select id={`models.${role}`} value={s.models[role] ?? ""} onChange={(e) => set(`models.${role}`, e.target.value)}>
            <option value="" disabled>router default</option>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      )))}
      {group("Budget", <>
        {num("budget.maxPodsPerDay", "max pods", "/day")}{num("budget.maxConcurrentSandboxes", "max concurrent sandboxes")}
        {num("budget.sandboxTimeoutMin", "sandbox timeout", "min")}{num("budget.exaCallsPerPod", "Exa calls", "/pod")}{num("budget.dailySpendCapUsd", "daily Anthropic spend cap", "USD")}
      </>)}
      {group("Risk limits", <>
        {num("limits.perTradeUsd", "per-trade", "USD")}{num("limits.perTradePct", "per-trade", "×B")}
        {num("limits.perMarket", "per-market", "USD")}{num("limits.perEvent", "per-event", "USD")}{num("limits.perCategory", "per-category", "USD")}
        {num("limits.totalOpen", "total open", "USD")}{num("limits.dailyNotional", "daily notional", "USD")}{num("limits.dailyLoss", "daily loss", "USD")}
        {num("limits.l3.perTradeUsd", "L3 auto ceiling", "USD")}{num("limits.l3.dailyNotional", "daily auto notional", "USD")}
        {multi("limits.l3.categoryAllowlist", "category allowlist")}
        <Field label="structural auto" error={errors["limits.l3.structuralAuto"]} htmlFor="limits.l3.structuralAuto">
          <input id="limits.l3.structuralAuto" type="checkbox" checked={s.limits.l3.structuralAuto} onChange={(e) => set("limits.l3.structuralAuto", e.target.checked)} />
        </Field>
      </>)}
      <FormGroup title="Appearance">
        <Field label="theme" htmlFor="theme">
          <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>{THEMES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </Field>
      </FormGroup>
    </>
  );
}

"use client";
import { ALLOWED_MODELS } from "@pm/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBar } from "../../../components/ErrorBar";
import { Field } from "../../../components/Field";
import { FormGroup } from "../../../components/FormGroup";
import { refitConfirm, refitPayload } from "../../../components/refit";
import { useSettingsForm } from "../../../components/SettingsForm";
import { SuggestedRefit } from "../../../components/SuggestedRefit";
import pg from "../../../components/page.module.css";
import { Panel, Segmented } from "../../../components/ui";
import { useTheme, type Theme } from "../../../hooks/useTheme";
import type { AppSettings } from "../../../lib/jobs/settings";

// Bankroll, sizing, risk limits, L3 caps and category overrides are edited in Autonomy.
const G = {
  filters: ["filters"], calibration: ["extremize"], weights: ["sizeTargets", "tDecayDays", "cCoef", "crowdBonus"], models: ["models"], budget: ["budget"],
} as const;
// Roles whose model the research run reads from Settings (packages/agents router), with what each one does.
const ROLES: readonly [role: string, hint: string][] = [
  ["triage", "Quick yes/no on whether a market is worth a full research run. One cheap call per market."],
  ["rules", "Reads the resolution rules: settling source, deadlines, edge cases."],
  ["source", "Finds the primary document or dataset that settles the question."],
  ["base_rate", "Estimates the prior from how often similar events happened."],
  ["news", "Scans the last 7 days of news for anything that moves the odds."],
  ["red_team", "Argues against the obvious reading and lists what would break the thesis."],
  ["judge", "Weighs the five analysts and writes the final probability and thesis."],
];
const MODELS = ALLOWED_MODELS.map((m) => ({ value: m, label: m }));
const THEMES: readonly { value: Theme; label: string }[] = [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }];

export function SettingsView({ initial, categories, defaultModels }: { initial: AppSettings; categories: string[]; defaultModels: Record<string, string> }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const f = useSettingsForm(initial);
  const { s, saved } = f;
  const [refitBusy, setRefitBusy] = useState(false);

  // Apply / Dismiss write on their own (not through the group's Save): extremize and/or suggested only; other unsaved edits stay in `s`.
  const refit = async (mode: "apply" | "dismiss") => {
    const sug = s.suggested;
    if (!sug || (mode === "apply" && !window.confirm(refitConfirm(sug)))) return;
    f.setMsg(null); setRefitBusy(true);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(refitPayload(mode, sug)) });
    const j = await r.json().catch(() => ({}));
    setRefitBusy(false);
    if (!r.ok) { f.setMsg(`${mode === "apply" ? "Apply" : "Dismiss"} failed: ${j.error ?? r.status}`); return; }
    f.setSaved((x) => ({ ...x, extremize: j.extremize, suggested: null })); f.setS((x) => ({ ...x, extremize: j.extremize, suggested: null })); router.refresh();
  };

  return (
    <div className={pg.stack}>
      <div className="page-h"><h1>Settings</h1></div>
      {f.msg && <ErrorBar message={f.msg} onRetry={() => f.setMsg(null)} />}
      <Panel pad label="trading limits">
        <p className={pg.hint}>Trading limits moved to Autonomy: bankroll, sizing, risk limits, L3 caps and category overrides. <Link href="/autonomy">Autonomy {"→"}</Link></p>
      </Panel>
      <div className={pg.cols}>
      {f.group("Filters", G.filters, <>
        {f.num("filters.minDays", "min days", { unit: "d", hint: "Skip markets that resolve sooner than this. Typical 2." })}
        {f.num("filters.maxDays", "max days", { unit: "d", hint: "Skip markets that resolve later than this. Typical 120." })}
        {f.num("filters.minDepthUsd", `min depth ${s.filters.depthCents}¢`, { unit: "USD", hint: `Dollars on the book within ${s.filters.depthCents}¢ of the mid, either side. Thinner markets are skipped. Typical 200.` })}
        {f.multi("filters.excludedCategories", "excluded categories", categories, "Markets with these categories or tags are never screened. Ctrl or Cmd click to pick several.")}
      </>, { intro: "Which markets the screener looks at. A market has to pass all of these." })}
      {f.group("Calibration", G.calibration, <>
        {s.suggested && <SuggestedRefit current={saved.extremize} suggested={s.suggested} dirty={f.dirty(G.calibration)} busy={refitBusy} onApply={() => void refit("apply")} onDismiss={() => void refit("dismiss")} />}
        {f.num("extremize", "extremize", { unit: "×", hint: "Pushes the research probability away from 50% (above 1) or toward it (below 1) before it is blended with the market. 1 = unchanged. The Journal suggests a value." })}
      </>, { id: "calibration" })}
      {f.group("Weights", G.weights, <>
        {f.num("sizeTargets.smallCap", "small-cap target", { unit: "USD", hint: "Dollars you want to fill near the best ask in a small market. A book that fills it gets full liquidity credit. Typical 200." })}
        {f.num("sizeTargets.size", "size target", { unit: "USD", hint: "The same for large markets. When half of it fills, the market ranks in the size tier. Typical 2,000." })}
        {f.num("tDecayDays", "T decay", { unit: "days", hint: "Markets resolving within this many days get full time credit; later ones are discounted. Typical 60." })}
        {f.num("cCoef", "C weight", { hint: "Boost for markets with strong crowd signals (few large holders, one-way flow). 0 = ignore. Typical 0.5." })}
        {f.num("crowdBonus", "C_against weight", { hint: "Extra rank for trades that go against a strong crowd. 0 = none. Typical 0.2." })}
      </>, { intro: "How markets are ranked for research and on the watchlist. They do not change trade size." })}
      {f.group("Models per role", G.models, ROLES.map(([role, hint]) => f.select(`models.${role}`, role, MODELS, `default · ${defaultModels[role] ?? "router default"}`, hint)),
        { intro: "Which Claude model each research step uses. Empty = the default shown. Bigger models cost more per run." })}
      {f.group("Research budget", G.budget, <>
        {f.num("budget.maxPodsPerDay", "max runs", { unit: "/day", hint: "Research runs (one per market) allowed per day. Typical 40." })}
        {f.num("budget.maxConcurrentSandboxes", "max concurrent sandboxes", { hint: "Analyst sandboxes running at once. One run uses up to 5. Typical 5." })}
        {f.num("budget.sandboxTimeoutMin", "sandbox timeout", { unit: "min", hint: "Longest one analyst may run before it is stopped. Typical 10." })}
        {f.num("budget.exaCallsPerPod", "web searches", { unit: "/run", hint: "Exa searches one research run may make. Typical 10." })}
        {f.num("budget.dailySpendCapUsd", "daily Anthropic spend cap", { unit: "USD", hint: "At the cap, research stops for the day and the screener falls back to its rules-only score. Typical 50." })}
      </>, { id: "budget", intro: "Caps on research cost and run time. New runs stop for the day once a daily cap is used up." })}
      <FormGroup title="Appearance">
        <Field label="theme" htmlFor="theme">
          <Segmented label="theme" options={THEMES} value={theme} onChange={setTheme} />
        </Field>
        {f.hint("theme", "Saved in this browser only.")}
      </FormGroup>
      </div>
    </div>
  );
}

import { BUILTIN_ROLES, type Steering } from "@pm/core";
import type { ReactNode } from "react";
import { Field } from "../Field";
import ui from "../ui.module.css";
import { Hint } from "./Hint";
import { NumInput } from "./NumInput";
import cx from "../../app/(app)/research/research.module.css";

const MAX_Q = 2000;
type Role = Steering["customRoles"][number];

const More = ({ summary, children }: { summary: string; children: ReactNode }) => (
  <details className={cx.more}><summary>{summary}</summary><div className={ui.grid2}>{children}</div></details>
);

/**
 * Steering fields for a FormGroup / grid. Shared by the profile editor and the market SteerDrawer.
 * `compact` (drawer): custom roles are only toggled from `customPool` (never edited), models collapse, advanced is omitted.
 * `errors` keys are relative to the steering object (`question`, `customRoles.0.key`, ...).
 */
export function SteeringForm({ value: v, onChange, errors, models, compact, customPool = [], disabled, idp }: {
  value: Steering; onChange: (v: Steering) => void; errors: Record<string, string>; models: readonly string[]; compact?: boolean; customPool?: Role[]; disabled?: boolean; idp: string;
}) {
  const set = (p: Partial<Steering>) => onChange({ ...v, ...p });
  const qLen = v.question?.length ?? 0;
  const roleKeys = [...v.roles, ...v.customRoles.map((r) => r.key)];
  const setCustom = (i: number, p: Partial<Role>) => set({ customRoles: v.customRoles.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const modelRows = [...roleKeys, "judge"].map((role) => (
    <Field key={role} label={`model: ${role}`} error={errors[`models.${role}`]} htmlFor={`${idp}-m-${role}`}>
      <select id={`${idp}-m-${role}`} disabled={disabled} value={v.models[role] ?? ""} onChange={(e) => {
        const { [role]: _, ...rest } = v.models;
        set({ models: (e.target.value ? { ...rest, [role]: e.target.value } : rest) as Steering["models"] });
      }}>
        <option value="">default</option>
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </Field>
  ));
  const nSet = Object.keys(v.models).filter((k) => k === "judge" || roleKeys.includes(k)).length;

  return (
    <>
      <Field label="operator question" error={errors.question} htmlFor={`${idp}-q`}>
        <span className={cx.stack}>
          <textarea id={`${idp}-q`} className={cx.q} rows={3} disabled={disabled} value={v.question ?? ""} onChange={(e) => set({ question: e.target.value })} />
          <span className={`${cx.counter} ${qLen > MAX_Q ? cx.counterOver : qLen > MAX_Q * 0.9 ? cx.counterWarn : ""}`}>{qLen}/{MAX_Q}</span>
        </span>
      </Field>
      <Hint>Optional. Every analyst and the judge read it, e.g. &ldquo;focus on the court schedule&rdquo;.</Hint>
      <Field label="roles" error={errors.roles} htmlFor={`${idp}-r-${BUILTIN_ROLES[0]}`}>
        <span className={cx.roles} role="group" aria-label="roles">
          {BUILTIN_ROLES.map((r) => (
            <label key={r} className={cx.check}>
              <input id={`${idp}-r-${r}`} type="checkbox" disabled={disabled} checked={v.roles.includes(r)}
                onChange={(e) => set({ roles: e.target.checked ? BUILTIN_ROLES.filter((x) => x === r || v.roles.includes(x)) : v.roles.filter((x) => x !== r) })} />
              {r}
            </label>
          ))}
          {compact && customPool.map((r) => (
            <label key={r.key} className={cx.check}>
              <input type="checkbox" disabled={disabled} checked={v.customRoles.some((c) => c.key === r.key)}
                onChange={(e) => set({ customRoles: e.target.checked ? [...v.customRoles, r] : v.customRoles.filter((c) => c.key !== r.key) })} />
              {r.key}
            </label>
          ))}
          <span className={`${cx.tag} muted`} title="the judge always runs">judge always runs</span>
        </span>
      </Field>
      <Hint>rules reads the resolution rules, source finds primary sources, base_rate checks how often this kind of event happens, news reads recent coverage, red_team argues the other side.</Hint>
      {!compact && (<>
        <Field label="custom roles" error={errors.customRoles} htmlFor={`${idp}-c-0`}>
          <span className={cx.custom}>
            {v.customRoles.map((r, i) => (
              <span key={i} className={cx.crow}>
                <input id={`${idp}-c-${i}`} aria-label={`custom role ${i + 1} key`} placeholder="a-z0-9_" maxLength={24} value={r.key} onChange={(e) => setCustom(i, { key: e.target.value })} />
                <textarea aria-label={`custom role ${i + 1} prompt`} rows={3} className={cx.q} placeholder="system prompt" value={r.prompt} onChange={(e) => setCustom(i, { prompt: e.target.value })} />
                <button type="button" aria-label={`remove custom role ${i + 1}`} onClick={() => set({ customRoles: v.customRoles.filter((_, j) => j !== i) })}>{"×"}</button>
                {(errors[`customRoles.${i}.key`] || errors[`customRoles.${i}.prompt`]) && <span className={ui.err} role="alert" style={{ gridColumn: "1 / -1" }}>{errors[`customRoles.${i}.key`] ?? errors[`customRoles.${i}.prompt`]}</span>}
              </span>
            ))}
            <span className={cx.tools}>
              <button type="button" disabled={v.customRoles.length >= 5 || roleKeys.length >= 10} onClick={() => set({ customRoles: [...v.customRoles, { key: "", prompt: "" }] })}>+ Add role</button>
              <span className="muted">{v.customRoles.length}/5 custom · {roleKeys.length}/10 roles</span>
            </span>
          </span>
        </Field>
        <Hint>Extra analysts you write yourself: a short key and the instructions it follows. Each one adds cost.</Hint>
      </>)}
      {compact
        ? <More summary={`models (${nSet} set)`}>{modelRows}<Hint>default = the model the server picks for that role.</Hint></More>
        : <>{modelRows}<Hint>Model per analyst and for the judge. default = the model the server picks for that role.</Hint></>}
      <Field label="max cost" unit="USD" error={errors.maxCostUsd} htmlFor={`${idp}-cost`}>
        <NumInput id={`${idp}-cost`} value={v.maxCostUsd} disabled={disabled} step="0.01" min={0} onChange={(n) => set({ maxCostUsd: n })} />
        <span className="muted ui">queued roles are skipped once reached; judge still runs</span>
      </Field>
      {!compact && (
        <More summary="Advanced">
          <Field label="Exa call cap" error={errors.exaCallCap} htmlFor={`${idp}-exa`}><NumInput id={`${idp}-exa`} value={v.exaCallCap} step="1" min={0} onChange={(n) => set({ exaCallCap: n })} /></Field>
          <Hint>Most web searches per analyst. Blank = server default.</Hint>
          <Field label="max turns" error={errors.maxTurns} htmlFor={`${idp}-turns`}><NumInput id={`${idp}-turns`} value={v.maxTurns} step="1" min={1} onChange={(n) => set({ maxTurns: n })} /></Field>
          <Hint>Most steps an analyst may take before it must answer. Blank = server default.</Hint>
        </More>
      )}
    </>
  );
}

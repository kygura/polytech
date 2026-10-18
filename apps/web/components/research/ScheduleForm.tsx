import { Field } from "../Field";
import { hm } from "../fmt";
import { NumInput } from "./NumInput";
import { UNITS, type Unit } from "./steering";

export function ScheduleForm({ every, unit, enabled, lastRunAt, error, onChange }: {
  every: number | undefined; unit: Unit; enabled: boolean; lastRunAt: number | null; error?: string; onChange: (p: { every?: number | undefined; unit?: Unit }) => void;
}) {
  return (
    <>
      <Field label="every" error={error} htmlFor="sch-every">
        <NumInput id="sch-every" value={every} min={1} step="1" onChange={(n) => onChange({ every: n })} />
        <select aria-label="schedule unit" value={unit} onChange={(e) => onChange({ unit: e.target.value as Unit })}>{(Object.keys(UNITS) as Unit[]).map((u) => <option key={u} value={u}>{u}</option>)}</select>
        <span className="muted ui">blank = manual only (Run now still works)</span>
      </Field>
      {enabled && every == null && <span className="warn ui" style={{ gridColumn: 2 }}>Enabled but no schedule — will not run automatically</span>}
      <span className="muted">last run</span><span>{lastRunAt == null ? "never" : hm(lastRunAt)}</span>
    </>
  );
}

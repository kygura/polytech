import { Field } from "../Field";
import { Hint } from "./Hint";
import { NumInput } from "./NumInput";
import type { FilterDraft } from "./steering";
import cx from "../../app/(app)/research/research.module.css";

const SORTS = ["priority", "vol24h", "edge", "endDate"] as const;

/** Filter fields for a FormGroup. `errors` keys are relative to `filter.`. */
export function FilterForm({ value: v, onChange, errors, categories }: { value: FilterDraft; onChange: (v: FilterDraft) => void; errors: Record<string, string>; categories: string[] }) {
  const set = (p: Partial<FilterDraft>) => onChange({ ...v, ...p });
  const opts = [...new Set([...categories, ...v.categories])].sort();
  const num = (k: keyof FilterDraft, label: string, unit: string | undefined, hint: string, o: { scale?: number; placeholder?: string; min?: number; max?: number; step?: string } = {}) => (<>
    <Field label={label} unit={unit} error={errors[k]} htmlFor={`f-${k}`}>
      <NumInput id={`f-${k}`} value={v[k] as number | undefined} onChange={(n) => set({ [k]: n })} {...o} />
    </Field>
    <Hint>{hint}</Hint>
  </>);
  return (
    <>
      <Field label="text query" error={errors.textQuery} htmlFor="f-textQuery">
        <input id="f-textQuery" value={v.textQuery} onChange={(e) => set({ textQuery: e.target.value })} />
        <span className="muted ui">case-insensitive, on question</span>
      </Field>
      <Field label="categories" error={errors.categories} htmlFor="f-categories">
        <select id="f-categories" multiple size={Math.min(6, Math.max(2, opts.length))} value={v.categories} onChange={(e) => set({ categories: [...e.target.selectedOptions].map((o) => o.value) })}>
          {opts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Hint>None selected = every category. Ctrl/⌘-click to pick several.</Hint>
      <Field label="tags (any)" error={errors.tagsAny} htmlFor="f-tags">
        <input id="f-tags" value={v.tags} placeholder="election, fed" onChange={(e) => set({ tags: e.target.value })} />
      </Field>
      <Hint>Polymarket tags, comma-separated. A market needs any one of them.</Hint>
      {num("minVol24h", "min 24h volume", "USD", "Skip markets that traded less than this in the last 24 hours.")}
      {num("minDepthUsd", "min depth 5¢", "USD", "Money resting within 5¢ of the price. Thinner books cannot fill a trade.")}
      {num("maxSpread", "max spread", "¢", "Skip markets whose gap between best bid and ask is wider.", { scale: 100 })}
      <Field label="ends within" unit="d" error={errors["endsWithinDays.min"] ?? errors["endsWithinDays.max"] ?? errors.endsWithinDays} htmlFor="f-endsMin">
        <span className={cx.rng}>
          <NumInput id="f-endsMin" value={v.endsMin} onChange={(n) => set({ endsMin: n })} placeholder="min" min={0} />
          {"–"}
          <NumInput id="f-endsMax" value={v.endsMax} onChange={(n) => set({ endsMax: n })} placeholder="max" min={0} />
        </span>
      </Field>
      <Hint>Days until the market resolves. Either end can be blank.</Hint>
      {num("minAbsEdge", "min |edge|", "¢", "Only markets whose current thesis shows at least this much edge, either side. For re-research.")}
      {v.minAbsEdge != null && <span className="muted ui" style={{ gridColumn: 2 }}>markets with no thesis are excluded when set</span>}
      {num("skipHours", "skip if researched within", "h", "Leave out markets researched this recently. Blank = 24 h, 0 = never skip.", { placeholder: "24", min: 0 })}
      <Field label="sort" error={errors.sort} htmlFor="f-sort">
        <select id="f-sort" value={v.sort} onChange={(e) => set({ sort: e.target.value as FilterDraft["sort"] })}>{SORTS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      </Field>
      <Hint>Which matches go first when there are more than the limit: priority = screener score, vol24h = most traded, edge = biggest current edge, endDate = resolves soonest.</Hint>
      {num("limit", "limit", undefined, "Most markets researched per run. Blank = 10, at most 50. Each run costs about $0.20–0.50.", { placeholder: "10", min: 1, max: 50, step: "1" })}
      <Field label="include ids" error={errors.includeConditionIds} htmlFor="f-include">
        <textarea id="f-include" className={cx.ids} rows={2} value={v.include} placeholder="paste condition ids, one per line" onChange={(e) => set({ include: e.target.value })} />
      </Field>
      <Hint>When set, only these markets can match (the other filters still apply).</Hint>
      <Field label="exclude ids" error={errors.excludeConditionIds} htmlFor="f-exclude">
        <textarea id="f-exclude" className={cx.ids} rows={2} value={v.exclude} placeholder="paste condition ids, one per line" onChange={(e) => set({ exclude: e.target.value })} />
      </Field>
      <Hint>Never research these markets with this profile.</Hint>
    </>
  );
}

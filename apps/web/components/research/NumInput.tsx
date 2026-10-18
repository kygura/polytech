const round = (v: number) => +v.toPrecision(12);

/** Blank = undefined (never 0). `scale` shows stored price units as cents. */
export function NumInput({ id, value, onChange, scale = 1, step = "any", min, max, placeholder, disabled }: {
  id: string; value: number | undefined; onChange: (v: number | undefined) => void; scale?: number; step?: string; min?: number; max?: number; placeholder?: string; disabled?: boolean;
}) {
  return (
    <input id={id} type="number" step={step} min={min} max={max} placeholder={placeholder} disabled={disabled}
      value={value == null || !Number.isFinite(value) ? "" : round(value * scale)}
      onChange={(e) => onChange(e.target.value === "" || Number.isNaN(e.target.valueAsNumber) ? undefined : round(e.target.valueAsNumber / scale))} />
  );
}

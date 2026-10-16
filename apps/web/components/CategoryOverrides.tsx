"use client";
import { MODES, type Mode } from "@pm/core";
import { ModeBadge } from "./ModeBadge";

export type CategoryRow = { category: string; override: Mode | null; effective: Mode };
const rank = (m: Mode) => MODES.indexOf(m);

/** Override may only lower the global mode. Options above global are disabled with the reason in title. */
export function CategoryOverrides({ rows, mode, onChange }: { rows: CategoryRow[]; mode: Mode; onChange: (category: string, override: Mode) => void }) {
  return (
    <section className="pane">
      <h2>Category overrides</h2>
      <table aria-label="category overrides">
        <thead><tr><th scope="col">Category</th><th scope="col">Override</th><th scope="col">Effective</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((r) => (
            <tr key={r.category}>
              <td className="ui">{r.category}</td>
              <td>
                <select value={r.override ?? ""} aria-label={`override for ${r.category}`} onChange={(e) => e.target.value && onChange(r.category, e.target.value as Mode)}>
                  {/* ponytail: PUT /api/settings deep-merges, so a set override cannot be cleared back to inherit in this build. */}
                  <option value="" disabled={r.override != null} title={r.override != null ? "clearing an override is not supported yet" : undefined}>inherit</option>
                  {(["L0", "L1"] as Mode[]).map((m) => <option key={m} value={m} disabled={rank(m) > rank(mode)} title={rank(m) > rank(mode) ? "cannot raise above global" : undefined}>{m}</option>)}
                </select>
              </td>
              <td><ModeBadge mode={r.effective} /></td>
            </tr>
          )) : <tr><td colSpan={3} className="muted">No categories yet</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

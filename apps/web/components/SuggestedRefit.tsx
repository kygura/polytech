import { refitDelta, type Suggested } from "./refit";
import { Button } from "./ui";
import ui from "./ui.module.css";

/** Settings > Calibration: the journal's suggested refit (DESIGN 12.4). Apply is disabled while the group has unsaved edits. */
export function SuggestedRefit({ current, suggested, dirty, busy, onApply, onDismiss }: { current: number; suggested: Suggested; dirty: boolean; busy?: boolean; onApply: () => void; onDismiss: () => void }) {
  return (
    <div className={ui.refit} role="group" aria-label="suggested refit">
      <p className="ui" style={{ margin: 0, fontWeight: 600 }}>Suggested from journal (n={suggested.n}, computed {suggested.at.slice(0, 10)})</p>
      <table aria-label="suggested refit">
        <thead><tr><th scope="col">component</th><th scope="col" className="num">current</th><th scope="col" className="num">suggested</th><th scope="col" className="num">Δ</th></tr></thead>
        <tbody><tr><td>extremize</td><td className="num">{current.toFixed(2)}</td><td className="num">{suggested.extremize.toFixed(2)}</td><td className="num">{refitDelta(current, suggested)}</td></tr></tbody>
      </table>
      <div className={ui.refitActions}>
        <Button onClick={onDismiss} disabled={busy}>Dismiss</Button>
        <Button variant="primary" onClick={onApply} disabled={busy || dirty} aria-describedby={dirty ? "refit-hint" : undefined}>Apply suggested</Button>
        {dirty && <span id="refit-hint" className="muted ui">Save or discard edits first</span>}
      </div>
    </div>
  );
}

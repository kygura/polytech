"use client";
import { useState } from "react";
import { hm } from "./fmt";
import { usd2, type SetView } from "./live";
import { Button } from "./ui";
import css from "./ui.module.css";

/** ErrorBar variant pinned on /autonomy, one per flagged set (DESIGN 9.2). Acknowledge closes nothing; it only clears the flag. */
export function FlaggedSetBar({ set: s, onAck }: { set: SetView; onAck: (id: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const ack = async () => { setBusy(true); setErr(await onAck(s.id)); setBusy(false); };
  // No flaggedAt in the payload: the time shown is when the set was proposed.
  return (
    <div className={`${css.bar} ${css.barErr}`} role="alert" style={{ flexDirection: "column", alignItems: "stretch", marginBottom: 0 }}>
      <strong className="down">Set needs manual action · {s.setKind} · {s.legs[0]?.question ?? s.eventId} · flagged {hm(s.createdAt)}</strong>
      {s.held.length > 0 && (
        <table aria-label="legs still held">
          <thead><tr><th scope="col">Market</th><th scope="col">Token</th><th scope="col" className="num">Shares held</th><th scope="col" className="num">Avg fill</th><th scope="col" className="num">Bid now</th></tr></thead>
          <tbody>
            {s.held.map((h) => (
              <tr key={h.conditionId}>
                <td className="ui">{h.question}</td>
                <td className={h.token === "YES" ? "yes" : "no"}>{h.token}</td>
                <td className="num">{Math.round(h.shares)}</td>
                <td className="num">{h.avgFill.toFixed(3)}</td>
                <td className="num">{h.bidNow == null ? "—" : h.bidNow.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.suggestedAction && <span className="ui">{s.suggestedAction}</span>}
      <span className="ui muted">The engine will not retry. Positions stay in Book › Live until closed.</span>
      <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center" }}>
        <Button size="sm" disabled={busy} onClick={() => void ack()} aria-label={`Acknowledge flagged set ${s.setKind}, ${s.legs.length} legs, cost ${usd2(s.costUsd)}`}>Acknowledge</Button>
        {err && <span className="down ui">{err}</span>}
      </span>
    </div>
  );
}

"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTradingMode } from "../hooks/useTradingMode";
import { MeterBar } from "./MeterBar";
import { SseIndicator, type SseStatus } from "./SseIndicator";
import { ageTone, fmtAge, runsLabel, spendLabel, SNAPSHOT_CADENCE_MS, SWEEP_CADENCE_MS, tradingLabel, utcClock, type OpStatus } from "./statusbar";
import { TRADING_HELP } from "./TradingModeSwitch";
import css from "./StatusBar.module.css";

/** Fixed bottom bar (DESIGN 12.1.5, 13.3): sse | trading mode | runs | spend | ingest ages | alerts | (slot: /trade key legend + feed) | [g…] clock. `status` null = not loaded yet or /api/status failing: segments show `—`. `slotRef` receives the slot element that workspace pages portal into. */
export function StatusBar({ status, sse, lastEventAt, chord, onAlerts, slotRef }: { status: OpStatus | null; sse: SseStatus; lastEventAt: number | null; chord: boolean; onAlerts: () => void; slotRef?: (el: HTMLElement | null) => void }) {
  const [now, setNow] = useState<number | null>(null); // null until mounted: no server/client clock mismatch
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const age = (t: number | null | undefined) => (t == null || now == null ? null : now - t);
  const snap = age(status?.snapshotAt), sweep = age(status?.sweepAt);
  const spend = spendLabel(status?.spendUsd ?? null, status?.capUsd ?? null);
  const showMeter = status?.spendUsd != null && status.capUsd != null && status.capUsd > 0;
  const unacked = status?.unacked ?? 0;
  const trading = tradingLabel(useTradingMode().mode);
  return (
    <footer className={css.bar} data-sse={sse} aria-label="status bar">
      <span className={css.seg}><SseIndicator status={sse} lastEventAt={lastEventAt} /></span>
      <span className={`${css.seg} ${trading.warn ? css.live : ""}`} title={TRADING_HELP} aria-label={`your trades: ${trading.warn ? "live, real money" : "paper, no real money"}`}>{trading.text}</span>
      <Link href="/runs" className={`${css.seg} ${status && status.runs > 0 ? css.text : ""}`} title={status?.pods.length ? status.pods.join("\n") : undefined}>
        {status ? runsLabel(status.runs) : "runs —"}
      </Link>
      <Link href="/settings#budget" className={`${css.seg} ${spend.capped ? css.capped : ""}`}>
        {spend.text}
        {showMeter && <span className={css.meter}><MeterBar value={status!.spendUsd!} max={status!.capUsd!} /></span>}
      </Link>
      <span className={`${css.seg} ${css.ingest}`}>
        snapshot <b className={css[ageTone(snap, SNAPSHOT_CADENCE_MS)]}>{fmtAge(snap)}</b> {"·"} sweep <b className={css[ageTone(sweep, SWEEP_CADENCE_MS)]}>{fmtAge(sweep)}</b>
      </span>
      <span className={css.seg} aria-live="polite">
        <button type="button" className={`${css.alerts} ${unacked > 0 ? css.alertsWarn : ""}`} onClick={onAlerts} aria-label={`${unacked} unacknowledged alert${unacked === 1 ? "" : "s"}`} title="alerts (g n)">alerts {unacked}</button>
      </span>
      <span ref={slotRef} className={css.slot} />
      <span className={css.end}>
        {chord && <span className={css.chord} aria-hidden>g…</span>}
        <span className={css.clock}>{now == null ? "" : utcClock(now)}</span>
      </span>
    </footer>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useTradingMode, type TradingMode } from "../hooks/useTradingMode";
import { Segmented } from "./ui";
import ui from "./ui/ui.module.css";
import css from "./TradingModeSwitch.module.css";

export const TRADING_HELP = "Your own trades on the Trade page. Paper fills against the real order book with no real money. Live sends real orders from your connected wallet. Separate from the Autonomy mode, which sets what the system does on its own.";

/** Header Paper | Live switch (per viewer, useTradingMode). Paper is one click; Live asks first. */
export function TradingModeSwitch() {
  const { mode, setMode } = useTradingMode();
  const [asking, setAsking] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (asking && !d.open) { d.showModal(); stay.current?.focus(); }
    if (!asking && d.open) d.close();
  }, [asking]);
  const pick = (m: TradingMode) => (m === "live" ? mode !== "live" && setAsking(true) : setMode("paper"));
  const live = mode === "live";
  const opts = [{ value: "paper" as const, label: "Paper" }, { value: "live" as const, label: live ? "LIVE" : "Live" }];
  return (
    <>
      <span className={css.sw} data-mode={mode} title={TRADING_HELP}>
        <Segmented label={`Your trades: ${live ? "live, real money" : "paper, no real money"}`} options={opts} value={mode} onChange={pick} />
      </span>
      <dialog ref={dlg} className={css.dlg} aria-labelledby="trading-live-h" onClose={() => setAsking(false)}>
        <h2 id="trading-live-h">Switch to live trading?</h2>
        <p>Live trading sends real orders from your connected wallet. Paper trading fills against the same order book with no real money.</p>
        <p className="muted">This only changes your own trades. What the system does on its own is set in Autonomy.</p>
        <div className={css.acts}>
          <button type="button" className={`${ui.btn} ${css.goLive}`} onClick={() => { setMode("live"); setAsking(false); }}>Switch to live</button>
          <button type="button" className={ui.btn} ref={stay} onClick={() => setAsking(false)}>Stay on paper</button>
        </div>
      </dialog>
    </>
  );
}

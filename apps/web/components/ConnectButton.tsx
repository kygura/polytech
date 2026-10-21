"use client";
import { useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { Drawer } from "./Drawer";
import css from "./Shell.module.css";
import ui from "./ui.module.css";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Header wallet button (DESIGN 13.3). One <button> across states so focus stays on it after connect (it turns into the address chip in place); the USDC balance sits beside it once connected. */
export function ConnectButton() {
  const w = useWallet();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const connected = w.status === "connected" && w.address;
  const label = connected
    ? <span className={`${css.chip} ${w.chainOk ? "" : "warn"}`}>{short(w.address!)}<span className={css.chipNet}> {"·"} {w.chainOk ? "Polygon" : "wrong network"}</span></span>
    : w.status === "connecting" ? <><span className={ui.spinner} aria-hidden /> Connecting…</>
    : w.status === "unavailable" ? "Install a wallet" : "Connect wallet";
  const copy = async () => {
    try { await navigator.clipboard.writeText(w.address!); setCopied(true); setTimeout(() => setCopied(false), 3000); } catch { /* clipboard denied: address stays visible to copy by hand */ }
  };
  const balance = w.clob.balance;
  return (
    <>
      {w.error && <span className={`neg ${css.headErr}`} role="status" title={w.error}>{w.error}</span>}
      {connected && balance != null && <span className={`${css.balance} n`} title="USDC balance"><span className="muted">USDC</span> {balance.toFixed(2)}</span>}
      <button
        type="button"
        className={`${css.wallet} ${connected ? "" : css.connect}`}
        disabled={w.status === "unavailable" || w.status === "connecting"}
        title={w.status === "unavailable" ? "No browser wallet detected. Install one such as MetaMask or Rabby to trade live." : connected ? "Wallet" : "Connect a browser wallet to place live trades on Trade"}
        aria-haspopup={connected ? "dialog" : undefined}
        onClick={() => (connected ? setMenu(true) : void w.connect())}
      >{label}</button>
      <Drawer open={menu} title="Wallet" onClose={() => setMenu(false)}>
        {connected && (
          <div className={css.menu}>
            <div className={css.row}><code>{w.address}</code><button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
            {w.funder?.mode === "polymarket" && <p className="muted" style={{ margin: 0 }}>Trades from your Polymarket account wallet <code>{short(w.funder.wallet)}</code>.</p>}
            {!w.chainOk && <button type="button" onClick={() => void w.switchChain()}>Switch to Polygon</button>}
            <button type="button" onClick={() => { w.disconnect(); setMenu(false); }}>Disconnect</button>
          </div>
        )}
      </Drawer>
    </>
  );
}

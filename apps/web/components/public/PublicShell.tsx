"use client";
// Visitor shell (DESIGN 10.1): no operator state, no /api/autonomy, no EventSource. Owns the wallet provider.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useClob } from "../../hooks/useClob";
import { useGlobalKeys } from "../../hooks/useGlobalKeys";
import { useTheme } from "../../hooks/useTheme";
import { useWallet, useWalletConnection, WalletContext } from "../../hooks/useWallet";
import { Drawer } from "../Drawer";
import { isTerminal, terminalNav } from "../../lib/terminalPath";
import { TERMINAL_SHORTCUTS } from "../terminal/shortcuts";
import shell from "../Shell.module.css";
import ui from "../ui.module.css";
import css from "./public.module.css";

const GO = { w: "/trade", a: "/trade/autonomy" };
const SHORTCUTS: [string, string][] = [
  ["g w / g a", "watchlist / autonomy"], ["j / k", "move selection"], ["Enter", "open row"],
  ["/", "focus filter"], ["Esc", "blur / close"], ["t", "toggle theme"], ["?", "this sheet"],
];

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// The terminal blocks g-navigation while an order is mid-send, and says why.
const canGo = () => { if (terminalNav.locked) terminalNav.onBlocked(); return !terminalNav.locked; };
export const DISCLAIMER = "Research output, not financial advice. Trading can lose all funds sent. Polymarket is not available in some jurisdictions; you are responsible for complying with yours.";

export function PublicShell({ children }: { children: ReactNode }) {
  const wallet = useWalletConnection();
  const clob = useClob(wallet.exchange);
  const path = usePathname();
  const sheet = useRef<HTMLDialogElement>(null);
  const { toggle } = useTheme();
  useGlobalKeys({ onHelp: useCallback(() => { const d = sheet.current; if (d) d.open ? d.close() : d.showModal(); }, []), onTheme: toggle, go: GO, canGo });

  const terminal = isTerminal(path); // the terminal (DESIGN 11) brings its own top bar and disclaimer
  return (
      <WalletContext.Provider value={{ ...wallet, clob }}>
        {terminal ? children : <>
        <header className={shell.header}>
          <Link href="/trade" className={shell.wordmark} style={{ whiteSpace: "nowrap" }}>PM-EDGE</Link>
          <span className={css.tagline}>{"·"} research</span>
          <nav className={shell.nav} aria-label="main">
            <Link href="/trade" aria-current={path === "/trade" || /^\/trade\/(?!autonomy)/.test(path) ? "page" : undefined}>Watchlist</Link>
            <Link href="/trade/autonomy" aria-current={path.startsWith("/trade/autonomy") ? "page" : undefined}>Autonomy</Link>
          </nav>
          <div className={shell.right}>
            <ConnectButton />
            <Link href="/login" className={css.signin}>Sign in</Link>
          </div>
        </header>
        <main className={shell.main}>{children}</main>
        <PublicFooter />
        </>}
        <dialog ref={sheet} className={shell.sheet} aria-label="keyboard shortcuts">
          <h2>Shortcuts</h2>
          <table><tbody>{(terminal ? TERMINAL_SHORTCUTS : SHORTCUTS).map(([k, d]) => <tr key={k}><th scope="row">{k}</th><td className="ui muted">{d}</td></tr>)}</tbody></table>
          <p className="muted ui" style={{ margin: "var(--sp-2) 0 0" }}>Esc closes</p>
        </dialog>
      </WalletContext.Provider>
  );
}

export function PublicFooter() {
  return (
    <p className={css.footer}>
      {DISCLAIMER}
    </p>
  );
}

/** One <button> across states so focus stays on it after connect (it turns into the AddressChip in place). */
export function ConnectButton() {
  const w = useWallet();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const connected = w.status === "connected" && w.address;
  const label = connected
    ? <span className={`${css.chip} ${w.chainOk ? "" : "warn"}`}>{short(w.address!)} {"·"} {w.chainOk ? "Polygon" : "wrong network"}</span>
    : w.status === "connecting" ? <><span className={ui.spinner} aria-hidden /> Connecting…</>
    : w.status === "unavailable" ? "No wallet found" : "Connect wallet";
  const copy = async () => {
    try { await navigator.clipboard.writeText(w.address!); setCopied(true); setTimeout(() => setCopied(false), 3000); } catch { /* clipboard denied: address stays visible to copy by hand */ }
  };
  return (
    <>
      {w.error && <span className={`neg ${css.headErr}`} role="status" title={w.error}>{w.error}</span>}
      <button
        type="button"
        className={connected ? undefined : css.connect}
        disabled={w.status === "unavailable" || w.status === "connecting"}
        title={w.status === "unavailable" ? "Install a browser wallet such as MetaMask or Rabby" : undefined}
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

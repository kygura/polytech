// Pure terminal rules (DESIGN 11.4–11.6): when the market may switch, what can be sold, and the ticket button by state. No React.
import type { OpenOrder } from "@pm/pm/exchange";
import type { OrderPhase } from "../../hooks/useOrderFlow";
import type { WalletStatus } from "../../hooks/useWallet";
import { truncate } from "../fmt";
import type { Gate } from "../public/ticket";
import { sh, usd, type Outcome } from "./book";

/** A switch while the wallet prompt is open or the send is being looked up would drop that order's outcome: block it. */
export const canSwitch = (p: OrderPhase["s"]) => p !== "signing" && p !== "checking" && p !== "unknown";

/** Sellable shares of a token: held minus what the visitor's own open SELL orders on it still have resting. */
export const sellable = (held: number, orders: Pick<OpenOrder, "tokenId" | "side" | "shares" | "filled">[], tokenId: string | null) =>
  !tokenId ? 0 : Math.max(0, held - orders.filter((o) => o.tokenId === tokenId && o.side === "SELL").reduce((a, o) => a + o.shares - o.filled, 0));

// DESIGN 10.4 copy; allowances now cover outcome tokens too (SELL), so the allowance steps say "trading allowances".
export const GATE: Record<Gate, { button: string; copy: string; spin?: boolean; off?: boolean }> = {
  disconnected: { button: "Connect wallet", copy: "Connect a wallet on Polygon to trade. Research above stays free to read." },
  wrong_network: { button: "Switch to Polygon", copy: "Your wallet is on another network. Polymarket runs on Polygon." },
  creds_needed: { button: "Enable trading (1 signature)", copy: "Polymarket needs a one-time signature to create your API key for this session. It is not a transaction and costs nothing." },
  allowance_checking: { button: "Checking trading allowances…", copy: "Checking whether Polymarket's exchange can trade your USDC and outcome tokens.", spin: true, off: true },
  allowance_needed: { button: "Approve trading allowances", copy: "Polymarket's exchange needs permission to trade your USDC and outcome tokens. These are on-chain transactions and cost a little POL for gas. One time per wallet." },
};

export type Action = "connect" | "switchChain" | "enable" | "approve" | "place" | "cancel" | "newOrder" | "recheck" | "reset";
export type Line = { text: string; tone?: "neg" | "up"; link?: "retryAllowance" | "startOver" };
export type ButtonState = { label: string; kbd: string[]; spin: boolean; off: boolean; look: "off" | "act" | "connect" | "yes" | "no"; word: string; line: Line | null; action: Action | null };

export type ButtonIn = {
  loaded: boolean; noBook: boolean; gate: Gate | null; wallet: WalletStatus; signing: boolean; allowanceError: string | null;
  phase: OrderPhase; valid: boolean; armed: boolean; outcome: Outcome; orderText: string;
  /** 0–1 price -> cents text on the live tick. */
  c: (p: number) => string;
};

const shortId = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Submit button + state line, by precedence: feed, gate, phase (DESIGN 11.6). */
export function buttonState(i: ButtonIn): ButtonState {
  const s = (o: Partial<ButtonState> & Pick<ButtonState, "label" | "word">): ButtonState => ({ kbd: [], spin: false, off: true, look: "off", line: null, action: null, ...o });
  if (!i.loaded) {
    return i.noBook ? s({ label: "Sign and place order", word: "waiting", line: { text: "No live book for this market." } })
      : s({ label: "Waiting for live book…", word: "waiting", spin: true, line: { text: "Prices and tick come from the live book. You can type shares now." } });
  }
  if (i.gate) {
    const g = GATE[i.gate], connecting = i.wallet === "connecting";
    const off = !!g.off || i.wallet === "unavailable" || connecting;
    const base = s({
      label: i.gate === "disconnected" && i.wallet === "unavailable" ? "No wallet found" : i.gate === "disconnected" && connecting ? "Connecting…" : g.button,
      word: i.gate.replace(/_/g, " "), spin: !!g.spin || connecting, off, look: i.gate === "disconnected" ? "connect" : off ? "off" : "act",
      line: { text: g.copy },
      action: i.gate === "disconnected" ? "connect" : i.gate === "wrong_network" ? "switchChain" : i.gate === "creds_needed" ? "enable" : i.gate === "allowance_needed" ? "approve" : null,
    });
    if (i.gate === "allowance_checking" && i.allowanceError) base.line = { text: i.allowanceError, link: "retryAllowance" };
    if ((i.gate === "creds_needed" || i.gate === "allowance_needed") && i.signing) return { ...base, label: "Confirm in your wallet…", spin: true, off: true, look: "off" };
    return base;
  }
  const p = i.phase;
  switch (p.s) {
    case "idle": {
      const line = { text: "Your wallet will ask you to sign this order. Signing sends it to Polymarket; it does not move funds until the order fills." };
      if (!i.valid) return s({ label: "Sign and place order", word: "ready", line });
      return s({ label: i.armed ? `Sign: ${i.orderText}` : i.orderText, kbd: i.armed ? ["⏎", "⌘⏎"] : ["⏎"], off: false, look: i.outcome === "YES" ? "yes" : "no", word: "ready", action: "place",
        line: i.armed ? { text: "⏎ again or ⌘⏎ signs. Esc returns to the fields." } : line });
    }
    case "checking": return s({ label: "Checking if your order went through…", word: "checking", spin: true, line: { text: "The send didn't confirm. Looking it up on Polymarket before anything else." } });
    case "signing": return s({ label: "Confirm in your wallet…", word: "signing", spin: true, line: { text: "Check your wallet window. Rejecting there cancels nothing; no order was sent." } });
    case "open":
      return s({
        label: p.cancelling ? "cancelling…" : p.filled > 0 ? "Cancel rest" : "Cancel order", kbd: p.cancelling ? [] : ["X"], off: !!p.cancelling, look: "act", action: "cancel",
        word: p.filled > 0 ? "partial" : "submitted",
        line: { text: p.filled > 0 ? `Partially filled · ${sh(p.filled)}/${sh(p.shares)}${p.avg != null ? ` at ${i.c(p.avg)}¢` : ""}` : `Order open · ord ${shortId(p.orderId)} · ${sh(p.filled)}/${sh(p.shares)} filled` },
      });
    case "filled": return s({ label: "New order", word: "filled", off: false, look: "act", action: "newOrder", line: { text: `Filled · ${sh(p.shares)} shares at ${i.c(p.avg)}¢ · fee ${usd(p.fee)}`, tone: "up" } });
    case "cancelled": return s({ label: "New order", word: "cancelled", off: false, look: "act", action: "newOrder", line: { text: `cancelled · ${sh(p.filled)}/${sh(p.shares)} filled` } });
    case "unknown": return s({ label: p.checking ? "Checking open orders…" : "Check open orders", word: "unknown", spin: !!p.checking, off: !!p.checking, look: p.checking ? "off" : "act", action: "recheck",
      line: { text: "Outcome unknown — check open orders before retrying.", tone: "neg", link: "startOver" } });
    case "error": return s({ label: "Try again", word: "error", off: false, look: "act", action: "reset", line: { text: `Order failed: ${truncate(p.msg, 80)}`, tone: "neg" } });
  }
}

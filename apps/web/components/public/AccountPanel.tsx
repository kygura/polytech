"use client";
// AccountPanel, detail-page form (DESIGN 10.5): collapsed under the ticket, this market's orders and positions only.
import { useState } from "react";
import { useWallet } from "../../hooks/useWallet";
import type { PublicMarketDetail } from "../../lib/public";
import { DataTable, type Column } from "../DataTable";
import { ErrorBar } from "../ErrorBar";
import type { OpenOrder } from "@pm/pm/exchange";
import { short } from "./PublicShell";
import css from "./public.module.css";

const usd = (v: number) => `$${v.toFixed(2)}`;
const n2 = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
type Pos = { side: "YES" | "NO"; shares: number; mid: number | null };

export function AccountPanel({ d }: { d: PublicMarketDetail }) {
  const w = useWallet(), c = w.clob;
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const m = d.market, yesMid = d.snapshot?.mid ?? null;
  const sideOf = (tokenId: string): "YES" | "NO" | null => (tokenId === m.yesTokenId ? "YES" : tokenId === m.noTokenId ? "NO" : null);

  let body;
  if (w.status !== "connected") body = <p className="muted">Connect wallet to see positions</p>;
  else if (!c.credsReady) body = <p className="muted">Enable trading in the ticket to load your orders and positions.</p>;
  else if (c.lastAt == null && !c.error) body = <p className="muted">Loading positions…</p>;
  else {
    const orders = c.orders.filter((o) => sideOf(o.tokenId));
    const inOrders = c.orders.reduce((a, o) => a + (o.side === "BUY" ? o.price * (o.shares - o.filled) : 0), 0);
    const pos: Pos[] = ([["YES", m.yesTokenId], ["NO", m.noTokenId]] as const)
      .filter(([, t]) => t && (c.positions[t] ?? 0) > 0)
      .map(([side, t]) => ({ side, shares: c.positions[t!]!, mid: yesMid == null ? null : side === "YES" ? yesMid : 1 - yesMid }));
    const cancel = async (id: string) => {
      setCancelling((s) => new Set(s).add(id));
      setErr(null);
      try { await c.cancel([id]); } catch (e) { setErr(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`); }
      finally { setCancelling((s) => { const x = new Set(s); x.delete(id); return x; }); }
    };
    const ORDER_COLS: Column<OpenOrder>[] = [
      { id: "side", header: "Side", align: "l", cell: (o) => { const s = sideOf(o.tokenId); return <span className={s === "YES" ? "pos" : "neg"}>{o.side} {s}</span>; } },
      { id: "shares", header: "Shares", align: "r", cell: (o) => n2(o.shares) },
      { id: "limit", header: "Limit", align: "r", cell: (o) => o.price.toFixed(3) },
      { id: "filled", header: "Filled", align: "r", cell: (o) => `${n2(o.filled)}/${n2(o.shares)}` },
      { id: "status", header: "Status", align: "l", cell: (o) => (o.filled > 0 ? "partial" : "open") },
      { id: "x", header: "", align: "l", cell: (o) => (cancelling.has(o.orderId) ? <span className="muted">cancelling…</span> : <button type="button" onClick={(e) => { e.stopPropagation(); void cancel(o.orderId); }} aria-label={`Cancel order ${short(o.orderId)}`}>Cancel</button>) },
    ];
    const POS_COLS: Column<Pos>[] = [
      { id: "side", header: "Side", align: "l", cell: (p) => <span className={p.side === "YES" ? "pos" : "neg"}>{p.side}</span> },
      { id: "shares", header: "Shares", align: "r", cell: (p) => n2(p.shares) },
      { id: "mid", header: "Mid now", align: "r", cell: (p) => (p.mid == null ? "—" : p.mid.toFixed(3)) },
      { id: "value", header: "Value $", align: "r", cell: (p) => (p.mid == null ? "—" : usd(p.shares * p.mid)) },
      { id: "sell", header: "", align: "l", cell: () => <a href={`https://polymarket.com/market/${m.conditionId}`} target="_blank" rel="noreferrer">Sell on Polymarket {"↗"}</a> },
    ];
    body = (
      <>
        {c.error && <ErrorBar message={c.error} onRetry={() => void c.refresh()} />}
        {err && <ErrorBar message={err} onDismiss={() => setErr(null)} />}
        <p className={css.sub}>
          <span>USDC {c.balance == null ? "—" : usd(c.balance)} {"·"} in orders {usd(inOrders)}</span>
          {w.funder && <span>{w.funder.mode === "polymarket" ? "Polymarket wallet" : "wallet"} {short(w.funder.wallet)}</span>}
        </p>
        {orders.length ? <DataTable columns={ORDER_COLS} rows={orders} rowKey={(o) => o.orderId} keys={false} label="open orders in this market" /> : <p className="muted">No open orders.</p>}
        {pos.length ? <DataTable columns={POS_COLS} rows={pos} rowKey={(p) => p.side} keys={false} label="positions in this market" /> : <p className="muted">No positions in this market.</p>}
      </>
    );
  }

  return (
    <details className="pane">
      <summary className={css.summary}>Your positions in this market</summary>
      <div className={css.acct}>{body}</div>
    </details>
  );
}

"use client";
import type { Mode } from "@pm/core";
import { useEffect, useState, type ReactNode } from "react";
import { ReconStatus } from "../../../components/ApprovalsPane";
import { DataTable, MarketCell, type Column } from "../../../components/DataTable";
import { ErrorBar } from "../../../components/ErrorBar";
import { NumCell } from "../../../components/NumCell";
import { Tabs } from "../../../components/Tabs";
import { hm, mmdd } from "../../../components/fmt";
import { shortId, type Recon } from "../../../components/live";
import css from "../../../components/panels.module.css";

// GET /api/book/live (DESIGN 8.2).
type LivePos = { conditionId: string; question: string; tokenId: string; outcome: string; shares: number; avgPrice: number; markPrice: number | null; unrealizedUsd: number | null };
type LiveOrder = { orderId: string; conditionId: string; question: string; side: string; price: number; shares: number; filledShares: number; status: string; expiresAt: string | number | null };
type LiveFill = { tradeId: string; conditionId: string; question: string; side: string; price: number; shares: number; feeUsd: number; at: string | number };
type LiveBook = { positions: LivePos[]; openOrders: LiveOrder[]; fills: LiveFill[]; recon: Recon | null };

const LIVE = <span className={`${css.chip} ${css.chipLive}`}>LIVE</span>;
const mkt = (r: { question: string }) => <><MarketCell question={r.question} category={null} max={40} />{LIVE}</>;
const sideCls = (s: string) => (/YES/i.test(s) ? "pos" : /NO/i.test(s) ? "neg" : undefined);
const t = (v: string | number) => new Date(v).getTime();

const ORDER_CLS: Record<string, string> = { failed: "neg", sending: "muted", unknown: "muted" };
const ORDER_COLS: Column<LiveOrder>[] = [
  { id: "market", header: "Market", align: "l", cell: mkt },
  { id: "side", header: "Side", align: "l", cell: (o) => <span className={sideCls(o.side)}>{o.side}</span> },
  { id: "shares", header: "Shares", align: "r", cell: (o) => <NumCell value={o.shares} fmt="int" /> },
  { id: "limit", header: "Limit", align: "r", cell: (o) => <NumCell value={o.price} fmt="p" /> },
  { id: "filled", header: "Filled", align: "r", cell: (o) => `${Math.round(o.filledShares)}/${Math.round(o.shares)}` },
  { id: "status", header: "Status", align: "l", cell: (o) => <span className={ORDER_CLS[o.status]}>{o.status}</span> },
  { id: "exp", header: "Expires", align: "r", cell: (o) => (o.expiresAt == null ? <span className="muted">{"—"}</span> : hm(t(o.expiresAt))) },
  { id: "order", header: "Order", align: "l", cell: (o) => <span title={o.orderId}>{shortId(o.orderId)}</span> },
];
const POS_COLS: Column<LivePos>[] = [
  { id: "market", header: "Market", align: "l", cell: mkt },
  { id: "side", header: "Side", align: "l", cell: (p) => <span className={sideCls(p.outcome)}>{p.outcome}</span> },
  { id: "size", header: "Size", align: "r", cell: (p) => <NumCell value={p.shares} fmt="int" /> },
  { id: "cost", header: "Avg cost", align: "r", cell: (p) => <NumCell value={p.avgPrice} fmt="p" /> },
  { id: "mark", header: "Mark", align: "r", cell: (p) => <NumCell value={p.markPrice} fmt="p" /> },
  { id: "unreal", header: "Unreal $", align: "r", cell: (p) => <NumCell value={p.unrealizedUsd} fmt="usd" signed /> },
];
const FILL_COLS: Column<LiveFill>[] = [
  { id: "ts", header: "ts", align: "r", cell: (f) => `${mmdd(t(f.at))} ${hm(t(f.at))}` },
  { id: "market", header: "Market", align: "l", cell: mkt },
  { id: "side", header: "Side", align: "l", cell: (f) => <span className={sideCls(f.side)}>{f.side}</span> },
  { id: "price", header: "Price", align: "r", cell: (f) => <NumCell value={f.price} fmt="p" /> },
  { id: "size", header: "Size", align: "r", cell: (f) => <NumCell value={f.shares} fmt="int" /> },
  { id: "fee", header: "Fee", align: "r", cell: (f) => f.feeUsd.toFixed(2) },
];

function LiveTab({ book, now }: { book: LiveBook; now: number }) {
  const { positions, openOrders, fills } = book;
  const pnl = positions.reduce((a, p) => a + (p.unrealizedUsd ?? 0), 0);
  if (!positions.length && !openOrders.length && !fills.length)
    return <><p className={`ui ${css.line}`} style={{ margin: 0 }}><ReconStatus recon={book.recon} now={now} /></p><p className={`muted ${css.line}`}>No live trades yet. Approvals appear at L2.</p></>;
  return (
    <>
      <p className={`ui ${css.line}`} style={{ margin: 0 }}><ReconStatus recon={book.recon} now={now} /></p>
      <div className={css.strip} aria-label="live P&L">
        <span className={`${css.chip} ${css.chipLive}`} style={{ marginLeft: 0 }}>LIVE</span>
        <span className={css.stripItem}><span className="muted ui">open</span> {positions.length}</span>
        <span className={css.stripItem}><span className="muted ui">P&L</span> $<NumCell value={pnl} fmt="usd" signed /></span>
      </div>
      <section className="pane">
        <h2>Open orders</h2>
        {openOrders.length ? <DataTable columns={ORDER_COLS} rows={openOrders} rowKey={(o) => o.orderId} keys={false} label="live open orders" /> : <p className={`muted ${css.line}`}>No open live orders.</p>}
      </section>
      <section className="pane" style={{ marginTop: "var(--sp-3)" }}>
        <h2>Positions</h2>
        {positions.length ? <DataTable columns={POS_COLS} rows={positions} rowKey={(p) => p.tokenId} keys={false} label="live positions" /> : <p className={`muted ${css.line}`}>No open positions.</p>}
      </section>
      <section className="pane" style={{ marginTop: "var(--sp-3)" }}>
        <h2>Fills</h2>
        {fills.length ? <DataTable columns={FILL_COLS} rows={fills} rowKey={(f) => f.tradeId} keys={false} label="live fills" /> : <p className={`muted ${css.line}`}>No fills yet.</p>}
      </section>
    </>
  );
}

/** Book = Live | Paper tabs; rows never share a table. Live is read client-side, refetched whenever the server re-renders (`at` changes). */
export function BookView({ mode, at, paperCount, children }: { mode: Mode; at: number; paperCount?: number; children: ReactNode }) {
  const [tab, setTab] = useState(mode === "L0" || mode === "L1" ? "paper" : "live");
  const [book, setBook] = useState<LiveBook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    fetch("/api/book/live")
      .then(async (r) => { if (!r.ok) throw new Error(`Live book failed: ${r.status}`); setBook(await r.json()); setErr(null); })
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(load, [at]);
  return (
    <>
      <div style={{ marginBottom: "var(--sp-3)" }}>
        <Tabs items={[{ id: "live", label: "Live", count: book ? book.positions.length : undefined }, { id: "paper", label: "Paper", count: paperCount }]} active={tab} onChange={setTab} />
      </div>
      {tab === "paper" ? children : <>
        {err && <ErrorBar message={err} onRetry={load} />}
        {book && <LiveTab book={book} now={at} />}
      </>}
    </>
  );
}

"use client";
import type { Mode } from "@pm/core";
import { useEffect, useState, type ReactNode } from "react";
import { ReconStatus } from "../../../components/ApprovalsPane";
import { DataTable, type Column } from "../../../components/DataTable";
import { ErrorBar } from "../../../components/ErrorBar";
import { NumCell } from "../../../components/NumCell";
import { Flat, Kpis, MarketCell, MarketTitle, Money } from "../../../components/pageParts";
import { Panel, Tabs } from "../../../components/ui";
import { hm, mmdd } from "../../../components/fmt";
import { approvalChip, shortId, type Recon } from "../../../components/live";
import css from "../../../components/panels.module.css";
import pg from "../../../components/page.module.css";

// GET /api/book/live (DESIGN 8.2).
type LivePos = { conditionId: string; question: string; tokenId: string; outcome: string; shares: number; avgPrice: number; markPrice: number | null; unrealizedUsd: number | null };
type Sent = { approval?: string | null; modeAtSend?: string | null; setId?: string | null };
type LiveOrder = Sent & { orderId: string; conditionId: string; question: string; side: string; price: number; shares: number; filledShares: number; status: string; expiresAt: string | number | null };
type LiveFill = Sent & { tradeId: string; conditionId: string; question: string; side: string; price: number; shares: number; feeUsd: number; at: string | number };
type LiveBook = { positions: LivePos[]; openOrders: LiveOrder[]; fills: LiveFill[]; recon: Recon | null };

const row2 = () => "row2";
const mkt = (r: { conditionId: string; question: string }) => <MarketTitle id={r.conditionId} question={r.question} />;
// Orders and fills also say who sent them and whether they are a set leg (DESIGN 9.2, 9.3).
const sentMkt = (r: Sent & { conditionId: string; question: string }) => {
  const a = approvalChip(r);
  return <MarketCell>{mkt(r)}{r.setId && <span className={css.chip} style={{ borderColor: "var(--border)", color: "var(--text)" }}>SET</span>}{a.text !== "user" && <span className={css.chip} style={{ borderColor: a.color, color: a.color }}>{a.text}</span>}</MarketCell>;
};
const sideCls = (s: string) => (/YES/i.test(s) ? "yes" : /NO/i.test(s) ? "no" : undefined);
const t = (v: string | number) => new Date(v).getTime();

const ORDER_CLS: Record<string, string> = { failed: "down", sending: "muted", unknown: "muted" };
const ORDER_COLS: Column<LiveOrder>[] = [
  { id: "market", header: "Market", align: "l", cell: sentMkt },
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
  { id: "market", header: "Market", align: "l", cell: sentMkt },
  { id: "side", header: "Side", align: "l", cell: (f) => <span className={sideCls(f.side)}>{f.side}</span> },
  { id: "price", header: "Price", align: "r", cell: (f) => <NumCell value={f.price} fmt="p" /> },
  { id: "size", header: "Size", align: "r", cell: (f) => <NumCell value={f.shares} fmt="int" /> },
  { id: "fee", header: "Fee", align: "r", cell: (f) => f.feeUsd.toFixed(2) },
];

function LiveTab({ book, now }: { book: LiveBook; now: number }) {
  const { positions, openOrders, fills } = book;
  const pnl = positions.reduce((a, p) => a + (p.unrealizedUsd ?? 0), 0);
  const recon = <ReconStatus recon={book.recon} now={now} />;
  if (!positions.length && !openOrders.length && !fills.length)
    return <Panel title="Live book" right={recon}><p className={`${pg.hint} ${pg.line}`}>No live trades yet. The system trades the server wallet from Autonomy L2 up; at L2 each trade waits for your approval.</p></Panel>;
  return (
    <div className={pg.stack}>
      <Panel title="Live book" label="live P&L" right={recon}>
        <Kpis label="live P&L" items={[{ label: "open positions", value: positions.length }, { label: "unrealized P&L", value: <Money value={pnl} /> }]} />
      </Panel>
      <Panel title="Open orders" right={<span className="n">{openOrders.length}</span>}>
        {openOrders.length ? <Flat><DataTable columns={ORDER_COLS} rows={openOrders} rowKey={(o) => o.orderId} keys={false} label="live open orders" rowClass={row2} /></Flat> : <p className={`${pg.hint} ${pg.line}`}>No open live orders.</p>}
      </Panel>
      <Panel title="Positions" right={<span className="n">{positions.length}</span>}>
        {positions.length ? <Flat><DataTable columns={POS_COLS} rows={positions} rowKey={(p) => p.tokenId} keys={false} label="live positions" rowClass={row2} /></Flat> : <p className={`${pg.hint} ${pg.line}`}>No open positions.</p>}
      </Panel>
      <Panel title="Fills" right={<span className="n">{fills.length}</span>}>
        {fills.length ? <Flat><DataTable columns={FILL_COLS} rows={fills} rowKey={(f) => f.tradeId} keys={false} label="live fills" rowClass={row2} /></Flat> : <p className={`${pg.hint} ${pg.line}`}>No fills yet.</p>}
      </Panel>
    </div>
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
    <div className={pg.stack}>
      <div className="page-h">
        <h1>Portfolio</h1>
        <div className="r">
          <Tabs label="book" panelId="book" items={[{ id: "live", label: "Live", count: book ? book.positions.length : undefined }, { id: "paper", label: "Paper", count: paperCount }]} active={tab} onChange={setTab} />
        </div>
      </div>
      <div role="tabpanel" id="book" aria-labelledby={`book-tab-${tab}`}>
        {tab === "paper" ? children : <div className={pg.stack}>
          {err && <ErrorBar message={err} onRetry={load} />}
          {book && <LiveTab book={book} now={at} />}
        </div>}
      </div>
    </div>
  );
}

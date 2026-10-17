import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { post, useFetch } from "../api";
import { clamp, hhmm, int, left, mmdd, num, pct, signed, signedInt } from "../fmt";
import type { LiveBook, PaperBook } from "../types";
import { type Cell, type Col, type Ctx, Err, Pane, sideColor, signColor, Table } from "../ui";

type Pos = PaperBook["positions"][number] | { sep: true };
const isSep = (p: Pos): p is { sep: true } => "sep" in p;
const c = <K extends keyof PaperBook["positions"][number]>(f: (p: PaperBook["positions"][number]) => string | [string, string | undefined]) => (p: Pos) => (isSep(p) ? "" : f(p));
const COLS: Col<Pos>[] = [
  { h: "", w: 5, cell: (p) => (isSep(p) ? "" : ["PAPER", "blue"]) },
  { h: "Market", w: 34, cell: (p) => (isSep(p) ? "── closed ──" : left(p.question, 34)) },
  { h: "Side", w: 4, cell: c((p) => [p.side, sideColor(p.side)]) },
  { h: "Size", w: 6, r: true, cell: c((p) => int(p.size)) },
  { h: "Cost", w: 5, r: true, cell: c((p) => num(p.avgCost)) },
  { h: "Mid", w: 5, r: true, cell: c((p) => num(p.midNow)) },
  { h: "Unreal$", w: 7, r: true, cell: c((p) => [signed(p.unrealizedUsd, 1), signColor(p.unrealizedUsd)]) },
  { h: "Mod e¢", w: 6, r: true, cell: c((p) => [signed(p.modeledEdgeC, 1), signColor(p.modeledEdgeC)]) },
  { h: "Real e¢", w: 7, r: true, cell: c((p) => [signed(p.realizedEdgeC, 1), signColor(p.realizedEdgeC)]) },
  { h: "Opened", w: 6, cell: c((p) => mmdd(p.openedAt)) },
];

// Live book (DESIGN 8.2/8.6): every row carries a LIVE text tag, never color alone.
const TAG = { h: "", w: 4, cell: (): Cell => ["LIVE", "yellow"] };
type L = LiveBook;
const ORD_COLOR: Record<string, string> = { failed: "red", sending: "gray", unknown: "gray" };
const ORD: Col<L["openOrders"][number]>[] = [
  TAG,
  { h: "Market", w: 30, cell: (o) => left(o.question, 30) },
  { h: "Side", w: 4, cell: (o) => o.side },
  { h: "Shares", w: 6, r: true, cell: (o) => int(o.shares) },
  { h: "Limit", w: 5, r: true, cell: (o) => num(o.price) },
  { h: "Filled", w: 11, r: true, cell: (o) => `${int(o.filledShares)}/${int(o.shares)}` },
  { h: "Status", w: 9, cell: (o) => [o.status, ORD_COLOR[o.status]] },
  { h: "Expires", w: 7, cell: (o) => (o.expiresAt == null ? "—" : hhmm(o.expiresAt)) },
  { h: "Order", w: 8, cell: (o) => o.orderId.slice(0, 8) },
];
const LPOS: Col<L["positions"][number]>[] = [
  TAG,
  { h: "Market", w: 34, cell: (p) => left(p.question, 34) },
  { h: "Side", w: 4, cell: (p) => [p.outcome, sideColor(p.outcome.toUpperCase())] },
  { h: "Shares", w: 6, r: true, cell: (p) => int(p.shares) },
  { h: "Avg", w: 5, r: true, cell: (p) => num(p.avgPrice) },
  { h: "Mark", w: 5, r: true, cell: (p) => num(p.markPrice) },
  { h: "Unreal$", w: 7, r: true, cell: (p) => [signed(p.unrealizedUsd, 1), signColor(p.unrealizedUsd)] },
];
const LFILL: Col<L["fills"][number]>[] = [
  TAG,
  { h: "ts", w: 5, cell: (f) => hhmm(f.at) },
  { h: "Market", w: 30, cell: (f) => left(f.question, 30) },
  { h: "Side", w: 4, cell: (f) => f.side },
  { h: "Price", w: 5, r: true, cell: (f) => num(f.price) },
  { h: "Shares", w: 6, r: true, cell: (f) => int(f.shares) },
  { h: "Fee$", w: 5, r: true, cell: (f) => num(f.feeUsd, 2) },
];

export function Paper({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState(0), [open, setOpen] = useState(false), [bump, setBump] = useState(0);
  const [tabSel, setTab] = useState<number | null>(null);
  const tab = tabSel ?? (ctx.mode >= "L2" ? 0 : 1); // 0 Live, 1 Paper; default Live at L2+
  const { data, error } = useFetch<PaperBook>("/api/paper", ctx.tick + bump);
  const live = useFetch<LiveBook>("/api/book/live", ctx.tick + bump);
  const lp = live.data?.positions ?? [];
  const rows: Pos[] = data ? [...data.positions.filter((p) => p.closedAt == null), { sep: true }, ...data.positions.filter((p) => p.closedAt != null)] : [];
  const cur = rows[clamp(sel, rows.length)];
  const n = tab === 0 ? lp.length : rows.length;
  useInput(
    (ch, key) => {
      if (open && (key.escape || key.backspace || key.delete)) setOpen(false);
      else if (!open && (ch === "h" || ch === "l" || key.leftArrow || key.rightArrow)) (setTab(1 - tab), setSel(0));
      else if (tab === 0 && ch === "x") ctx.flash("live positions close via an exit proposal", "yellow");
      else if (tab === 0 && key.return) return;
      else if (key.return && cur && !isSep(cur)) setOpen(true);
      else if (ch === "x" && !open && cur && !isSep(cur) && cur.closedAt == null)
        post<{ realizedPnl: number }>(`/api/paper/${cur.id}/close`).then(
          (r) => (ctx.flash(`closed ${left(cur.question, 30).trim()} · realized ${signed(r.realizedPnl, 2)}$`), setBump((b) => b + 1)),
          (e: Error) => ctx.flash(`close failed: ${e.message}`, "red"),
        );
      else if (ch === "j" || key.downArrow) setSel((s) => clamp(s + 1, n));
      else if (ch === "k" || key.upArrow) setSel((s) => clamp(s - 1, n));
    },
    { isActive: ctx.active },
  );
  const tabs = (
    <Text>
      {" "}
      {["Live", "Paper"].map((t, i) => (
        <Text key={t} color={i === tab ? "cyan" : "gray"} bold={i === tab}>{`[${t}${i === 0 ? (live.data ? ` ${lp.length}` : "") : data ? ` ${data.summary.open}` : ""}] `}</Text>
      ))}
      <Text color="gray">  h/l switch</Text>
    </Text>
  );
  if (tab === 0) {
    const L = live.data;
    if (!L) return <Box flexDirection="column">{tabs}<Err error={live.error} /></Box>;
    const unreal = L.positions.reduce((t, p) => t + (p.unrealizedUsd ?? 0), 0);
    const oh = Math.min(L.openOrders.length, 4) + 1, fh = Math.min(L.fills.length, 3) + 1;
    return (
      <Box flexDirection="column">
        {tabs}
        <Text>
          <Text color="yellow" bold> LIVE</Text>
          {` · open orders ${L.openOrders.length} · positions ${L.positions.length} · unreal P&L `}<Text color={signColor(unreal)}>{signed(unreal, 2)}$</Text>
        </Text>
        {!L.positions.length && !L.openOrders.length && !L.fills.length ? <Text color="gray"> No live trades yet. Approvals appear at L2.</Text> : (
          <>
            <Text color="gray" bold> open orders</Text>
            {L.openOrders.length ? <Table cols={ORD} rows={L.openOrders} sel={-1} height={oh} width={ctx.w} /> : <Text color="gray">  No open live orders.</Text>}
            <Text color="gray" bold> positions</Text>
            <Table cols={LPOS} rows={L.positions} sel={clamp(sel, lp.length)} height={Math.max(2, ctx.h - 5 - oh - fh)} width={ctx.w} />
            <Text color="gray" bold> fills</Text>
            <Table cols={LFILL} rows={L.fills} sel={-1} height={fh} width={ctx.w} />
          </>
        )}
      </Box>
    );
  }
  if (ctx.mode === "L0") return <Box flexDirection="column">{tabs}<Text color="gray"> Paper book is off. Autonomy view: press 1 to set L1.</Text></Box>;
  if (!data) return <Box flexDirection="column">{tabs}<Err error={error} /></Box>;
  const s = data.summary;
  if (open && cur && !isSep(cur)) {
    const fills = data.fills.filter((f) => f.conditionId === cur.conditionId);
    return (
      <Pane title={`Fills · ${cur.question} · Esc back`}>
        <Text color="gray">{"  ts     side  price  size    fee    k      slip¢"}</Text>
        {fills.map((f, i) => (
          <Text key={i}>{"  " + hhmm(f.ts)}  <Text color={sideColor(f.side)}>{left(f.side ?? "—", 4)}</Text>  {num(f.price)}  {int(f.size, 6)}  {num(f.fee, 2, 5)}  {num(f.modeledK)}  <Text color={signColor(f.slipC == null ? null : -f.slipC)}>{signed(f.slipC, 1, 6)}</Text></Text>
        ))}
        {!fills.length && <Text color="gray">(no fills)</Text>}
      </Pane>
    );
  }
  return (
    <Box flexDirection="column">
      {tabs}
      <Text>
        <Text color="blue" bold> PAPER</Text>
        {` · open ${s.open}  closed ${s.closed}  paper P&L `}<Text color={signColor(s.paperPnlUsd)}>{signedInt(s.paperPnlUsd)}$</Text>
        {`  modeled edge `}<Text color={signColor(s.modeledEdgeUsd)}>{signedInt(s.modeledEdgeUsd)}$</Text>
        {`  realized `}<Text color={signColor(s.realizedEdgeUsd)}>{signedInt(s.realizedEdgeUsd)}$</Text>
        {`  capture ${pct(s.capture)}`}
      </Text>
      <Table cols={COLS} rows={rows} sel={clamp(sel, rows.length)} height={ctx.h - 2} width={ctx.w} />
    </Box>
  );
}

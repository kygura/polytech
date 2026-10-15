import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { post, useFetch } from "../api";
import { ago, clamp, int, left, mmdd, num, pct, signed, signedInt, sparkline, usd, windowStart } from "../fmt";
import type { MarketDetail, StructuralRow, WatchlistRow } from "../types";
import { type Cell, type Col, type Ctx, Err, Pane, sideColor, signColor, Table } from "../ui";

const TABS = ["small-cap", "size", "structural"] as const;
const SORTS = ["rank", "edge", "r_ann", "days"] as const;
type Row = WatchlistRow | StructuralRow;
const isStruct = (r: Row): r is StructuralRow => "lockedC" in r;

const edge = (v: number | null): Cell => [signed(v, 1), signColor(v)];
const THESIS: Col<WatchlistRow>[] = [
  { h: "#", w: 3, r: true, cell: (r) => int(r.rank) },
  { h: "Market", w: 40, cell: (r) => left(r.question, 40) },
  { h: "Side", w: 4, cell: (r) => [r.side ?? "—", sideColor(r.side)] },
  { h: "p_mid", w: 5, r: true, hide: 3, cell: (r) => num(r.pMid) },
  { h: "p̂", w: 5, r: true, cell: (r) => [num(r.pHat), r.thesisAgeH != null && r.thesisAgeH > 72 ? "gray" : undefined] },
  { h: "p_post", w: 6, r: true, cell: (r) => num(r.pPost) },
  { h: "Edge¢", w: 6, r: true, cell: (r) => edge(r.edgeC) },
  { h: "Size$", w: 6, r: true, cell: (r) => int(r.sizeUsd) },
  { h: "E[P]$", w: 6, r: true, cell: (r) => [signedInt(r.expectedProfit), signColor(r.expectedProfit)] },
  { h: "r_ann", w: 5, r: true, cell: (r) => pct(r.rAnn, undefined, 5) },
  { h: "Payoff", w: 6, r: true, hide: 2, cell: (r) => (r.payoff == null ? "—" : `${r.payoff.toFixed(2)}×`) },
  { h: "Days", w: 4, r: true, cell: (r) => int(r.daysLeft) },
  { h: "c", w: 5, r: true, cell: (r) => [num(r.c, 2), r.capped ? "yellow" : undefined] },
  { h: "Catalyst", w: 24, hide: 1, cell: (r) => left(r.nextCatalyst ?? "—", 24) },
];
const STRUCT: Col<StructuralRow>[] = [
  { h: "#", w: 3, r: true, cell: () => "" },
  { h: "Market", w: 40, cell: (r) => left(r.question, 40) },
  { h: "Type", w: 12, cell: (r) => r.type },
  { h: "Legs", w: 4, r: true, cell: (r) => int(r.legs) },
  { h: "Σ", w: 6, r: true, cell: (r) => num(r.sum) },
  { h: "Locked¢", w: 7, r: true, cell: (r) => edge(r.lockedC) },
  { h: "Size$", w: 6, r: true, cell: (r) => int(r.sizeUsd) },
  { h: "Days", w: 4, r: true, cell: (r) => int(r.daysLeft) },
];

export function Watchlist({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState(0), [sortI, setSortI] = useState(0), [flip, setFlip] = useState(false);
  const [filter, setFilter] = useState(""), [typing, setTyping] = useState(false);
  const [sel, setSel] = useState(0), [open, setOpen] = useState<string | null>(null), [local, setLocal] = useState(0);
  const { data, error } = useFetch<Row[]>(`/api/watchlist?tab=${TABS[tab]}&sort=${SORTS[sortI]}`, ctx.tick + local);
  const q = filter.toLowerCase();
  let rows = (data ?? []).filter((r) => !q || r.question.toLowerCase().includes(q) || (r.category ?? "").toLowerCase().includes(q));
  if (flip) rows = [...rows].reverse();
  const cur = rows[clamp(sel, rows.length)];
  const refresh = () => setLocal((x) => x + 1);

  const type = (on: boolean) => (setTyping(on), ctx.setTyping(on));
  useInput(
    (ch, key) => {
      if (key.return) type(false);
      else if (key.escape) (setFilter(""), type(false));
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (ch && !key.ctrl && !key.meta) setFilter((f) => f + ch);
    },
    { isActive: typing },
  );
  useInput(
    (ch, key) => {
      const n = rows.length;
      if (ch === "j" || key.downArrow) setSel((s) => clamp(s + 1, n));
      else if (ch === "k" || key.upArrow) setSel((s) => clamp(s - 1, n));
      else if (ch === "h" || key.leftArrow) (setTab((t) => (t + 2) % 3), setSel(0));
      else if (ch === "l" || key.rightArrow) (setTab((t) => (t + 1) % 3), setSel(0));
      else if (ch === "/") type(true);
      else if (ch === "s") setSortI((i) => (i + 1) % SORTS.length);
      else if (ch === "S") setFlip((f) => !f);
      else if (key.return && cur) setOpen(cur.conditionId);
      else if (cur && (ch === "r" || ch === "p" || ch === "m")) act(ch, cur, ctx, refresh);
    },
    { isActive: ctx.active && !typing && !open },
  );

  if (open) return <Detail id={open} ctx={ctx} back={() => (setOpen(null), refresh())} />;
  const count = (t: number) => (t === tab && data ? ` ${data.length}` : "");
  return (
    <Box flexDirection="column">
      <Text>
        {" "}
        {TABS.map((t, i) => (
          <Text key={t} color={i === tab ? "cyan" : "gray"} bold={i === tab}>{`[${t === "small-cap" ? "Small-cap" : t === "size" ? "Size" : "Structural"}${count(i)}] `}</Text>
        ))}
        {"       filter: "}
        <Text color={typing ? "cyan" : undefined}>{filter}{typing ? "▮" : ""}</Text>
        {"       sort: "}
        <Text color="cyan">{SORTS[sortI]} {flip ? "▼" : "▲"}</Text>
      </Text>
      {!data && <Err error={error} />}
      {data && (tab === 2
        ? <Table cols={STRUCT} rows={rows as StructuralRow[]} sel={clamp(sel, rows.length)} height={ctx.h - 1} width={ctx.w} prefix={pin} />
        : <Table cols={THESIS} rows={rows as WatchlistRow[]} sel={clamp(sel, rows.length)} height={ctx.h - 1} width={ctx.w} prefix={pin} />)}
    </Box>
  );
}
const pin = (r: Row) => (r.pinned ? <Text color="cyan">●</Text> : " ");

/** r re-research, p pin toggle, m mute. Shared by list and detail. */
async function act(ch: string, row: { conditionId: string; pinned: boolean; muted: boolean }, ctx: Ctx, refresh: () => void) {
  try {
    if (ch === "r") (await post(`/api/markets/${row.conditionId}/research`), ctx.flash("research started", "cyan"));
    else if (ch === "p") (await post(`/api/markets/${row.conditionId}/flags`, { pinned: !row.pinned }), ctx.flash(row.pinned ? "unpinned" : "pinned", "cyan"));
    else (await post(`/api/markets/${row.conditionId}/flags`, { muted: !row.muted }), ctx.flash(row.muted ? "unmuted" : "muted", "yellow"));
    refresh();
  } catch (e) {
    ctx.flash((e as Error).message, "red");
  }
}

function Detail({ id, ctx, back }: { id: string; ctx: Ctx; back: () => void }) {
  const [local, setLocal] = useState(0), [scroll, setScroll] = useState(0);
  const { data: d, error } = useFetch<MarketDetail>(`/api/markets/${id}`, ctx.tick + local);
  const ev = d?.evidence ?? [];
  useInput(
    (ch, key) => {
      if (key.escape || key.backspace || key.delete) back();
      else if (ch === "j" || key.downArrow) setScroll((s) => clamp(s + 1, ev.length));
      else if (ch === "k" || key.upArrow) setScroll((s) => clamp(s - 1, ev.length));
      else if (d && (ch === "r" || ch === "p" || ch === "m")) act(ch, d.market, ctx, () => setLocal((x) => x + 1));
    },
    { isActive: ctx.active },
  );
  if (!d) return <Err error={error} />;
  const { market: m, snapshot: s, thesis: t } = d;
  const half = Math.floor((ctx.w - 2) / 2);
  const evH = Math.max(3, ctx.h - 15), start = windowStart(scroll, evH, ev.length);
  const level = (b?: { price: number; size: number }) => (b ? `${num(b.price)} ${int(b.size, 6)}` : "            ");
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="gray">{" ← Watchlist   "}</Text>
        <Text bold>{left(m.question, ctx.w - 50)}</Text>
        <Text color="gray">{`  ${m.category ?? "—"} · ends ${mmdd(m.endDate)} · ${Math.round(m.daysLeft)}d · fee ${pct(m.feeRate)}`}</Text>
      </Text>
      <Text>{s ? ` mid ${num(s.mid)}  bid ${num(s.bestBid, 2)}  ask ${num(s.bestAsk, 2)}  depth5¢ ${usd(s.depth5cUsd)}  vol24h ${usd(s.vol24h)}  OI ${usd(s.oi)}  top10 ${pct(s.top10Share)}` : " no snapshot"}</Text>
      <Text color="cyan"> {sparkline(d.history.map((h) => h.mid))}</Text>
      <Box>
        <Pane title={t ? `Thesis · ${t.model ?? "judge"} · ${ago((Date.now() - t.createdAt) / 3.6e6)}` : "Thesis"} width={half}>
          {t ? (
            <>
              <Text>
                {`p̂ ${num(t.pHat)}  c ${num(t.c, 2)}  p_post ${num(t.pPost)}  edge `}
                <Text color={signColor(t.edgeC)}>{signed(t.edgeC, 1)}¢</Text>
              </Text>
              <Text>{`size ${usd(t.sizeUsd)}  E[P] `}<Text color={signColor(t.expectedProfit)}>{t.expectedProfit == null ? "—" : (t.expectedProfit >= 0 ? "+" : "-") + usd(Math.abs(t.expectedProfit))}</Text>{`  r_ann ${pct(t.rAnn, undefined, 5)}  pay ${t.payoff == null ? "—" : t.payoff.toFixed(1) + "×"}`}</Text>
              {t.expiresAt != null && t.expiresAt < Date.now() && <Text color="gray">Expired — re-research</Text>}
              <Text wrap="wrap">{t.thesis ?? ""}</Text>
              <Text color="gray" bold>Kill criteria</Text>
              {t.killCriteria.map((k, i) => <Text key={i}>○ {k}</Text>)}
            </>
          ) : <Text color="gray">no thesis yet — press r to research</Text>}
        </Pane>
        <Pane title="Book" width={half}>
          <Text color="gray">{"  bids           asks"}</Text>
          {Array.from({ length: Math.min(5, Math.max(s?.bids.length ?? 0, s?.asks.length ?? 0)) }, (_, i) => (
            <Text key={i}>{level(s?.bids[i])}   {level(s?.asks[i])}</Text>
          ))}
          {t?.k != null && <Text>k(S)={num(t.k)}</Text>}
          <Text color="gray" bold>Catalysts</Text>
          {(t?.catalysts ?? []).slice(0, 4).map((c, i) => <Text key={i}>{c}</Text>)}
        </Pane>
      </Box>
      <Pane title={`Evidence (${ev.length})`}>
        {ev.slice(start, start + evH).map((e, i) => {
          const dir = e.direction === "for" || e.direction === "+" ? "+" : e.direction === "against" || e.direction === "-" ? "−" : "·";
          return (
            <Text key={e.id} inverse={start + i === scroll} wrap="truncate">
              <Text color={dir === "+" ? "green" : dir === "−" ? "red" : "gray"}>{dir}</Text> {left(e.role, 7)} {left(e.claim, 44)} <Text color="gray">{left(e.quote ? `"${e.quote}"` : "", 30)}</Text> {mmdd(e.publishedAt)} <Text color="gray">{e.url ? new URL(e.url).hostname : ""}</Text>
            </Text>
          );
        })}
        {!ev.length && <Text color="gray">(none)</Text>}
      </Pane>
    </Box>
  );
}

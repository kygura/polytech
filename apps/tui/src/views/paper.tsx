import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { post, useFetch } from "../api";
import { clamp, hhmm, int, left, mmdd, num, pct, signed, signedInt } from "../fmt";
import type { PaperBook } from "../types";
import { type Col, type Ctx, Err, Pane, sideColor, signColor, Table } from "../ui";

type Pos = PaperBook["positions"][number] | { sep: true };
const isSep = (p: Pos): p is { sep: true } => "sep" in p;
const c = <K extends keyof PaperBook["positions"][number]>(f: (p: PaperBook["positions"][number]) => string | [string, string | undefined]) => (p: Pos) => (isSep(p) ? "" : f(p));
const COLS: Col<Pos>[] = [
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

export function Paper({ ctx }: { ctx: Ctx }) {
  const [sel, setSel] = useState(0), [open, setOpen] = useState(false), [bump, setBump] = useState(0);
  const { data, error } = useFetch<PaperBook>("/api/paper", ctx.tick + bump);
  const rows: Pos[] = data ? [...data.positions.filter((p) => p.closedAt == null), { sep: true }, ...data.positions.filter((p) => p.closedAt != null)] : [];
  const cur = rows[clamp(sel, rows.length)];
  useInput(
    (ch, key) => {
      if (open && (key.escape || key.backspace || key.delete)) setOpen(false);
      else if (key.return && cur && !isSep(cur)) setOpen(true);
      else if (ch === "x" && !open && cur && !isSep(cur) && cur.closedAt == null)
        post<{ realizedPnl: number }>(`/api/paper/${cur.id}/close`).then(
          (r) => (ctx.flash(`closed ${left(cur.question, 30).trim()} · realized ${signed(r.realizedPnl, 2)}$`), setBump((b) => b + 1)),
          (e: Error) => ctx.flash(`close failed: ${e.message}`, "red"),
        );
      else if (ch === "j" || key.downArrow) setSel((s) => clamp(s + 1, rows.length));
      else if (ch === "k" || key.upArrow) setSel((s) => clamp(s - 1, rows.length));
    },
    { isActive: ctx.active },
  );
  if (ctx.mode === "L0") return <Text color="gray"> Paper book is off. Autonomy view: press 1 to set L1.</Text>;
  if (!data) return <Err error={error} />;
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
      <Text>
        {` open ${s.open}  closed ${s.closed}  paper P&L `}<Text color={signColor(s.paperPnlUsd)}>{signedInt(s.paperPnlUsd)}$</Text>
        {`  modeled edge `}<Text color={signColor(s.modeledEdgeUsd)}>{signedInt(s.modeledEdgeUsd)}$</Text>
        {`  realized `}<Text color={signColor(s.realizedEdgeUsd)}>{signedInt(s.realizedEdgeUsd)}$</Text>
        {`  capture ${pct(s.capture)}`}
      </Text>
      <Table cols={COLS} rows={rows} sel={clamp(sel, rows.length)} height={ctx.h - 1} width={ctx.w} />
    </Box>
  );
}

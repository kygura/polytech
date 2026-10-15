import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useFetch } from "../api";
import { int, left, num, signed } from "../fmt";
import type { Calibration as CalT } from "../types";
import { type Ctx, Err, signColor } from "../ui";

const WINDOWS = [30, 90, 365, 0]; // 0 = all

export function Calibration({ ctx }: { ctx: Ctx }) {
  const [cat, setCat] = useState(0), [model, setModel] = useState(0), [win, setWin] = useState(1), [focus, setFocus] = useState(0);
  const all = useFetch<CalT>("/api/calibration", ctx.tick).data; // unfiltered: option lists
  const cats = ["all", ...Object.keys(all?.byCategory ?? {})], models = ["all", ...Object.keys(all?.byModel ?? {})];
  const q = new URLSearchParams();
  if (cat) q.set("category", cats[cat]!);
  if (model) q.set("model", models[model]!);
  if (WINDOWS[win]) q.set("sinceDays", String(WINDOWS[win]));
  const { data, error } = useFetch<CalT>(`/api/calibration?${q}`, ctx.tick);
  const cycle = (i: number, n: number, d: number) => (i + d + n) % n;
  useInput(
    (_ch, key) => {
      if (key.tab && !key.shift) setFocus((f) => (f + 1) % 3);
      else if (key.leftArrow || key.rightArrow) {
        const d = key.rightArrow ? 1 : -1;
        if (focus === 0) setCat((i) => cycle(i, cats.length, d));
        else if (focus === 1) setModel((i) => cycle(i, models.length, d));
        else setWin((i) => cycle(i, WINDOWS.length, d));
      }
    },
    { isActive: ctx.active },
  );
  const sel = (label: string, v: string, i: number) => <Text key={i} color={focus === i ? "cyan" : undefined} inverse={focus === i}>{`${label}: ${v} ▾`}</Text>;
  if (!data) return <Err error={error} />;
  const o = data.overall, d = o ? o.brier - o.marketBrier : null;
  return (
    <Box flexDirection="column">
      <Text> {sel("category", cats[cat]!, 0)}   {sel("model", models[model]!, 1)}   {sel("window", WINDOWS[win] ? `${WINDOWS[win]}d` : "all", 2)}</Text>
      <Text>{o ? ` Brier ${num(o.brier)}  log loss ${num(o.logLoss, 2)}  n ${o.n}   market Brier ${num(o.marketBrier)}   Δ ` : ` n 0 — no resolved forecasts`}{o && <Text color={signColor(d == null ? null : -d)}>{signed(d, 3)}</Text>}</Text>
      <Text color="gray">{"  " + left("Category", 12) + "    n  Brier  Mkt     Δ       logloss  c     gate"}</Text>
      {Object.entries(data.byCategory).map(([k, v]) => (
        <Text key={k}>
          {"  " + left(k, 12)} {int(v.n, 4)}  {num(v.brier, 3)}  {num(v.marketBrier, 3)}  <Text color={signColor(v.marketBrier - v.brier)}>{signed(v.brier - v.marketBrier, 3)}</Text>  {num(v.logLoss, 2, 7)}  {num(v.c, 2)}  {v.gate}{Number(v.gate.split("/")[0]) >= 30 ? " ✓" : ""}
        </Text>
      ))}
      {Object.keys(data.byModel).length > 0 && <Text color="gray">{"  " + left("Model", 24) + "   n   Brier  Mkt"}</Text>}
      {Object.entries(data.byModel).map(([k, v]) => (
        <Text key={k}>{"  " + left(k, 24)} {int(v.n, 4)}  {num(v.brier, 3)}  {num(v.marketBrier, 3)}</Text>
      ))}
    </Box>
  );
}

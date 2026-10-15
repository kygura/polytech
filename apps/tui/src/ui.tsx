import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { windowStart } from "./fmt";
import type { Mode } from "./types";

export const MODE_COLOR: Record<Mode, string> = { L0: "gray", L1: "blue", L2: "yellow", L3: "magenta", L4: "red" };
export const MODE_NAME: Record<Mode, string> = { L0: "Observe", L1: "PAPER", L2: "Approve", L3: "Bounded", L4: "Full" };
export const signColor = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? "green" : "red");
export const sideColor = (s: string | null | undefined) => (s === "YES" ? "green" : s === "NO" ? "red" : "gray");

/** Shared by every view: refresh tick, body size, footer flash, typing guard, current mode. */
export type Ctx = { tick: number; w: number; h: number; active: boolean; mode: Mode; flash: (text: string, color?: string) => void; setTyping: (on: boolean) => void };

/** Cell: plain string (padded by the column) or [string, color]. */
export type Cell = string | [string, string | undefined];
export type Col<T> = { h: string; w: number; r?: boolean; hide?: number; cell: (row: T) => Cell };

export function fitCols<T>(cols: Col<T>[], width: number): Col<T>[] {
  let out = cols;
  const total = (c: Col<T>[]) => c.reduce((t, x) => t + x.w + 1, 0);
  while (total(out) > width && out.some((c) => c.hide)) {
    const min = Math.min(...out.filter((c) => c.hide).map((c) => c.hide!));
    out = out.filter((c) => c.hide !== min);
  }
  return out;
}

const pad = (s: string, c: Col<unknown>) => (s.length > c.w ? s.slice(0, c.w) : c.r ? s.padStart(c.w) : s.padEnd(c.w));

export function Table<T>({ cols, rows, sel, height, width, prefix }: { cols: Col<T>[]; rows: T[]; sel: number; height: number; width: number; prefix?: (row: T) => ReactNode }) {
  const cs = fitCols(cols, width - 2);
  const h = Math.max(1, height - 1), start = windowStart(sel, h, rows.length);
  return (
    <Box flexDirection="column">
      <Text color="gray">{"  " + cs.map((c) => pad(c.h, c as Col<unknown>)).join(" ")}</Text>
      {rows.slice(start, start + h).map((row, i) => {
        const idx = start + i, on = idx === sel;
        return (
          <Text key={idx} inverse={on} wrap="truncate">
            {on ? "▶" : " "}
            {prefix?.(row) ?? " "}
            {cs.map((c, j) => {
              const v = c.cell(row), s = typeof v === "string" ? v : v[0], color = typeof v === "string" ? undefined : v[1];
              return (
                <Text key={j} color={color}>
                  {pad(s, c as Col<unknown>) + (j < cs.length - 1 ? " " : "")}
                </Text>
              );
            })}
          </Text>
        );
      })}
      {!rows.length && <Text color="gray">  (empty)</Text>}
    </Box>
  );
}

export const Pane = ({ title, children, width, height }: { title: string; children: ReactNode; width?: number | string; height?: number }) => (
  <Box flexDirection="column" borderStyle="single" borderColor="gray" width={width} height={height} overflow="hidden" paddingX={1}>
    <Text color="gray" bold>{title}</Text>
    {children}
  </Box>
);

export const Err = ({ error }: { error?: string }) => (error ? <Text color="red">error: {error}</Text> : <Text color="gray">loading…</Text>);

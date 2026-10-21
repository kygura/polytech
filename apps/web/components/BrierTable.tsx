import { fmt } from "./fmt";

/** ours − market; negative is good → --up. Sign always shown. (The by-category / by-model tables live in journal/BreakdownTable.) */
export const Delta = ({ ours, market }: { ours: number; market: number }) => {
  const d = ours - market;
  return <span className={d < 0 ? "up" : d > 0 ? "down" : "muted"}>{fmt(d, "p", true)}</span>;
};

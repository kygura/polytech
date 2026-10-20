// Terminal market list: one row shape for the watchlist and the all-markets query, plus the query text sent to /api/markets.
import type { PublicWatchRow } from "../../lib/public";
import type { ScreenerRow } from "../screener/types";

export type ListMode = "watch" | "all";
export type ListRow = { conditionId: string; question: string; category: string | null; yes: number | null; daysLeft: number | null; vol24h: number | null; endDate: number | null };

export const SORTS = [
  { value: "-vol24h", label: "Volume" },
  { value: "-liq", label: "Liquidity" },
  { value: "days", label: "Ending" },
  { value: "-price", label: "Likely" },
] as const;
export type SortKey = (typeof SORTS)[number]["value"];
export const LIST_LIMIT = 200;

export const fromWatch = (r: PublicWatchRow): ListRow =>
  ({ conditionId: r.conditionId, question: r.question, category: r.category, yes: r.midNow, daysLeft: r.daysLeft, vol24h: null, endDate: r.endDate });

export const fromScreener = (r: ScreenerRow, now: number): ListRow => {
  const end = r.endDate ? Date.parse(r.endDate) : null;
  return { conditionId: r.conditionId, question: r.question, category: r.category, yes: r.mid, daysLeft: end == null ? null : (end - now) / 86_400_000, vol24h: r.vol24h, endDate: end };
};

/** Free text plus DSL keys go through as typed; a list sort is appended unless the text already sorts. Ended markets are left out unless asked for. */
export function allQuery(text: string, sort: SortKey): string {
  const t = text.trim();
  const parts = [t];
  if (!/(^|\s)-?days:/.test(t)) parts.push("days:>0");
  if (!/(^|\s)sort:/.test(t)) parts.push(`sort:${sort}`);
  if (!/(^|\s)limit:/.test(t)) parts.push(`limit:${LIST_LIMIT}`);
  return parts.filter(Boolean).join(" ");
}

/** Watchlist filter: every word must appear in the question or category. */
export function matchWatch(r: PublicWatchRow, text: string, cat: string | null): boolean {
  if (cat && r.category !== cat) return false;
  const hay = `${r.question} ${r.category ?? ""}`.toLowerCase();
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** `62¢`, or `62.5¢` off a whole cent; `<1¢` / `>99¢` at the edges. */
export function pc(p: number | null): string {
  if (p == null) return "—";
  const c = p * 100;
  if (c > 0 && c < 1) return "<1¢";
  if (c < 100 && c > 99) return ">99¢";
  return `${Math.abs(c - Math.round(c)) < 0.05 ? Math.round(c) : c.toFixed(1)}¢`;
}

export const volShort = (v: number | null) => (v == null ? null : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${Math.round(v)}`);
export const daysShort = (d: number | null) => (d == null ? "—" : d < 1 ? `${Math.max(0, Math.round(d * 24))}h` : `${Math.round(d)}d`);

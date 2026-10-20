// Pure helpers for the /trade market list (DESIGN 13.4 MarketList). No React.
import { isWide, usdShort } from "./book";

/** One row of GET /api/markets (the fields the list reads). Times are ISO strings. */
export type ListRow = {
  conditionId: string; question: string; category: string | null; endDate: string | null; vol24h: number | null;
  mid: number | null; bestBid: number | null; bestAsk: number | null; ts: string | null;
  pinned: boolean; muted: boolean; thesis: { id: string } | null; d24c: number | null;
};
export type Facet = { category: string; n: number };

/** Condition ids are 0x-hex. Anything else in /trade/[id] (`/trade/autonomy`) is a 404 before any request goes out. */
export const isMarketId = (id: string) => /^0x[0-9a-f]+$/i.test(id);

export const LIST_LIMIT = 200;
export const STALE_ROW_MS = 6 * 3_600_000;

/** The request: all tracked markets by name (and category), biggest 24h volume first, pinned and watched rows ahead, muted hidden. */
export function listUrl(query: string, cat: string | null): string {
  const text = query.trim();
  const filter = { ...(text ? { text } : {}), ...(cat ? { categories: [cat] } : {}), muted: false, sort: [{ field: "volume24h", dir: "desc" }], limit: LIST_LIMIT };
  return `/api/markets?watchFirst=1&filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

/** `5d`, `<1d`, `ended`; `—` without an end date. */
export function daysLabel(endDate: string | null, now: number): string {
  if (!endDate) return "—";
  const d = (Date.parse(endDate) - now) / 86_400_000;
  return Number.isNaN(d) ? "—" : d < 0 ? "ended" : d < 1 ? "<1d" : `${Math.round(d)}d`;
}

/** Signed cents with one decimal: `+0.5`, `−1.2`; `0.0` when flat; `—` when unknown. */
export function changeLabel(c: number | null): { text: string; dir: "up" | "down" | "flat" | "none" } {
  if (c == null || !Number.isFinite(c)) return { text: "—", dir: "none" };
  const r = Math.round(c * 10) / 10;
  return r > 0 ? { text: `+${r.toFixed(1)}`, dir: "up" } : r < 0 ? { text: `−${Math.abs(r).toFixed(1)}`, dir: "down" } : { text: "0.0", dir: "flat" };
}

export const volLabel = (v: number | null) => (v == null ? null : usdShort(v));
export const staleRow = (r: Pick<ListRow, "ts">, now: number) => r.ts == null || now - Date.parse(r.ts) > STALE_ROW_MS;
/** A book wider than 10¢ has no trustworthy midpoint and the list has no last trade price: the pill is flagged. */
export const wideRow = (r: Pick<ListRow, "bestBid" | "bestAsk">) => isWide(r.bestBid, r.bestAsk);

/** Empty-state copy: a name search that finds nothing says so; the thesis copy was wrong there. */
export function emptyCopy(query: string, cat: string | null): string {
  const q = query.trim();
  if (q) return `No market matches "${q}"${cat ? ` in ${cat}` : ""}.`;
  return cat ? `No markets in ${cat}.` : "No tracked markets yet. The first sweep is in progress.";
}

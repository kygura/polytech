import type { SortField } from "@pm/core";
import type { ReactNode } from "react";
import type { Column } from "../DataTable";
import { EdgeBadge } from "../EdgeBadge";
import { fmt } from "../fmt";
import { NumCell } from "../NumCell";
import { PricePill } from "../ui";
import ui from "../ui.module.css";
import css from "./screener.module.css";
import type { ScreenerRow } from "./types";

export const STALE_TRADE_H = 48; // `Z` badge threshold

export const hoursSince = (iso: string | null, now: number) => (iso ? Math.max(0, (now - Date.parse(iso)) / 3_600_000) : null);
/** `18h` under two days, then `4d`. */
export const ageLabel = (h: number | null) => (h == null ? "—" : h < STALE_TRADE_H ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
export const daysLeft = (iso: string | null, now: number) => (iso ? (Date.parse(iso) - now) / 86_400_000 : null);

export const SRC: Record<string, string> = { official_data: "off", scheduled_event: "sch", media_report: "med", subjective: "sub", unknown: "unk" };
const dash = <span className="muted">{"—"}</span>;

type Ctx = { now: number; researching: ReadonlySet<string> };
type ColDef = { id: string; label: string; header?: ReactNode; width: string; minWidth?: string; align: "l" | "r"; sortField?: SortField; title?: string; cell: (r: ScreenerRow, c: Ctx) => ReactNode };

/** Compact USD for 48-60px cells (`12.3k`, `1.2m`, same suffixes the bar accepts); under 1000 it is `fmt` "usd". Full value in the title. */
export function usdShort(v: number | null | undefined, signed = false): string {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  const body = a < 1000 ? fmt(a, "usd") : a < 1e6 ? `${(a / 1e3).toFixed(a < 1e5 ? 1 : 0)}k` : `${(a / 1e6).toFixed(a < 1e7 ? 1 : 0)}m`;
  return v < 0 ? `\u2212${body}` : signed ? `+${body}` : body;
}
const UsdCell = ({ value, signed }: { value: number | null | undefined; signed: boolean }) =>
  <span className={value == null ? "muted" : signed ? (value > 0 ? "up" : value < 0 ? "down" : "muted") : undefined} title={value == null ? undefined : fmt(value, "usd", signed)}>{usdShort(value, signed)}</span>;

const num = (id: string, label: string, width: string, sortField: SortField | undefined, get: (r: ScreenerRow) => number | null | undefined, f: Parameters<typeof NumCell>[0]["fmt"], extra: Partial<ColDef> = {}, signed = false): ColDef =>
  ({ id, label, width, align: "r", sortField, cell: (r) => (f === "usd" ? <UsdCell value={get(r)} signed={signed} /> : <NumCell value={get(r)} fmt={f} signed={signed} />), ...extra });

export function Badge({ letter, color, title }: { letter: string; color: string; title: string }) {
  return <span className={css.badge} style={{ color }} title={title} aria-label={title} role="img">{letter}</span>;
}

/** `● S C T Z` in fixed order, DESIGN 12.2. `T` is filled in the thesis side's outcome colour (dashed and dim once expired). */
function Flags({ r, c }: { r: ScreenerRow; c: Ctx }) {
  const h = hoursSince(r.lastTradeTs, c.now), t = r.thesis;
  const side = t?.side.toUpperCase() === "NO" ? "NO" : "YES";
  return (
    <span className={css.flags}>
      {r.pinned && <span className={css.pinDot} title="pinned" role="img" aria-label="pinned">{"●"}</span>}
      {r.structural?.length ? <Badge letter="S" color="var(--badge-s)" title={`structural: ${r.structural.join(", ")}`} /> : null}
      {r.opportunity?.contrarian && <Badge letter="C" color="var(--badge-c)" title="contrarian" />}
      {t && <span className={`${css.thesis} ${side === "NO" ? css.thesisNo : css.thesisYes} ${t.expired ? css.thesisOld : ""}`} role="img"
        title={`Thesis: ${side}, edge ${t.edgeC >= 0 ? "+" : "\u2212"}${Math.abs(t.edgeC).toFixed(1)}\u00a2${t.expired ? " (expired)" : ""}`}
        aria-label={`thesis ${side}${t.expired ? " expired" : ""}`}>T</span>}
      {h != null && h > STALE_TRADE_H && <Badge letter="Z" color="var(--warn)" title={`no trade for ${Math.round(h / 24)}d`} />}
      {c.researching.has(r.conditionId) && <span className={ui.spinner} role="status" aria-label="researching" />}
    </span>
  );
}

/** Two-line market cell: wraps, clamps at two lines, full question in the tooltip (DESIGN 13.5). */
const Question = ({ text }: { text: string }) => <span className="q" title={text}>{text}</span>;

/** YES left, NO right, 6px track; the split is the YES mid. */
function ProbBar({ mid }: { mid: number | null }) {
  if (mid == null) return <span className="muted">{"—"}</span>;
  const yes = Math.min(100, Math.max(0, mid * 100));
  return (
    <span className={css.pbar} role="img" aria-label={`YES ${Math.round(yes)}%`} title={`YES ${yes.toFixed(1)}% · NO ${(100 - yes).toFixed(1)}%`}>
      <span className={css.pbarYes} style={{ width: `${yes}%` }} /><span className={css.pbarNo} />
    </span>
  );
}

const prioFill = (p: number | null) => ({ background: p == null ? undefined : `color-mix(in srgb, var(--focus) ${Math.round(Math.min(1, Math.max(0, p)) * 20)}%, transparent)` });

export const COLUMNS: ColDef[] = [
  { id: "flags", label: "Flags", width: "72px", align: "l", title: "● pinned · S structural · C contrarian · T has a thesis (colour = its side, dashed = expired) · Z no trade for 2d+", cell: (r, c) => <Flags r={r} c={c} /> },
  { id: "market", label: "Market", width: "", minWidth: "320px", align: "l", cell: (r) => <Question text={r.question} /> },
  { id: "yes", label: "YES¢", width: "64px", align: "r", sortField: "price", title: "YES price, mid", cell: (r) => (r.mid == null ? dash : <PricePill outcome="YES" price={r.mid} />) },
  { id: "no", label: "NO¢", width: "64px", align: "r", title: "NO price, 1 − YES mid", cell: (r) => (r.mid == null ? dash : <PricePill outcome="NO" price={1 - r.mid} />) },
  { id: "prob", label: "P", width: "96px", align: "l", title: "YES / NO probability split", cell: (r) => <ProbBar mid={r.mid} /> },
  num("mid", "Mid", "56px", undefined, (r) => r.mid, "p"),
  num("sprd", "Sprd", "52px", "spread", (r) => (r.spread == null ? null : r.spread * 100), "cents", { title: "spread, cents" }),
  num("liq", "Liq", "64px", "liquidity", (r) => r.liquidity, "usd"),
  num("vol24", "Vol24", "60px", "volume24h", (r) => r.vol24h, "usd", { title: "24h volume, markets" }),
  num("d2", "D±2¢", "60px", "depth2c", (r) => r.depth2c, "usd", { title: "depth within 2¢ of mid" }),
  num("days", "Days", "48px", "daysToResolution", () => null, "int", { cell: (r, c) => <NumCell value={daysLeft(r.endDate, c.now)} fmt="int" /> }),
  { id: "stale", label: "Stale", width: "48px", align: "r", sortField: "stalenessHours", title: "since last trade", cell: (r, c) => { const h = hoursSince(r.lastTradeTs, c.now); return h == null ? dash : <span className={h > STALE_TRADE_H ? "warn" : undefined}>{ageLabel(h)}</span>; } },
  num("top1", "Top1", "48px", "holderTop1Share", (r) => r.top1Share, "pct", { title: "top holder share" }),
  { id: "src", label: "Src", width: "40px", align: "l", title: "resolution source", cell: (r) => (r.resolutionSource ? <span title={r.resolutionSource}>{SRC[r.resolutionSource] ?? r.resolutionSource}</span> : dash) },
  { id: "prio", label: "Prio", width: "52px", align: "r", sortField: "priority", cell: (r) => <span className={css.fill} style={prioFill(r.priority)}>{r.priority == null ? "—" : r.priority.toFixed(2)}</span> },
  { id: "opp", label: "Opp", width: "52px", align: "r", sortField: "opportunity", title: "opportunity score O", cell: (r) => (r.opportunity ? <span>{r.opportunity.o.toPrecision(3)}</span> : dash) },
  { id: "edge", label: "Edge¢", width: "56px", align: "r", sortField: "edge", cell: (r) => <EdgeBadge cents={r.opportunity ? r.opportunity.edge * 100 : null} /> },
  // ---- picker extras ----
  num("bid", "Bid", "52px", undefined, (r) => r.bestBid, "p"),
  num("ask", "Ask", "52px", undefined, (r) => r.bestAsk, "p"),
  num("d1c", "D±1¢", "60px", undefined, (r) => r.depth1c, "usd"),
  num("d5c", "D±5¢", "60px", undefined, (r) => r.depth5c, "usd"),
  num("exit", "Exit", "60px", undefined, (r) => r.exitDepth, "usd", { title: "exit depth" }),
  num("cap", "Cap", "60px", undefined, (r) => r.capacity, "usd", { title: "capacity" }),
  num("holders", "Holders", "60px", "holderCount", (r) => r.holderCount, "int"),
  { id: "hhi", label: "HHI", width: "48px", align: "r", title: "holder HHI", cell: (r) => (r.holderHhi == null ? dash : r.holderHhi.toFixed(2)) },
  num("top5", "Top5", "48px", undefined, (r) => r.top5Share, "pct"),
  num("flow24", "Flow24", "64px", undefined, (r) => r.flow24h, "usd", { title: "24h net flow" }, true),
  num("ticket", "Ticket", "56px", undefined, (r) => r.tradeMedian, "usd", { title: "median trade size" }),
  { id: "lasttrade", label: "Last trade", width: "96px", align: "l", title: "UTC", cell: (r) => (r.lastTradeTs ? r.lastTradeTs.slice(5, 16).replace("T", " ") : dash) },
  { id: "end", label: "End", width: "88px", align: "l", cell: (r) => (r.endDate ? r.endDate.slice(0, 10) : dash) },
  { id: "cat", label: "Cat", width: "96px", align: "l", cell: (r) => r.category ?? dash },
];

export const DEFAULT_COLS = ["flags", "market", "yes", "no", "prob", "sprd", "liq", "vol24", "days", "prio", "edge"];
/** Rev 7 default set: a saved copy of exactly this is the old default, not a choice, so it moves to the new default. */
const OLD_DEFAULT = "flags,market,mid,sprd,liq,vol24,d2,days,stale,top1,src,prio,opp,edge";
export const COL_LABEL = new Map(COLUMNS.map((c) => [c.id, c.label]));
const BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

/** Keep known ids, drop repeats; empty or all-unknown falls back to the default set. */
export function cleanCols(ids: unknown): string[] {
  const out = Array.isArray(ids) ? ids.filter((x, i, a): x is string => typeof x === "string" && BY_ID.has(x) && a.indexOf(x) === i) : [];
  return out.length && out.join() !== OLD_DEFAULT ? out : DEFAULT_COLS;
}

/** Column ids for a view: its own saved columns win, then the localStorage entry (JSON text), then the defaults. */
export function pickCols(viewCols: unknown, saved: string | null): string[] {
  if (Array.isArray(viewCols) && viewCols.length) return cleanCols(viewCols);
  if (saved) try { return cleanCols(JSON.parse(saved)); } catch { /* corrupt entry */ }
  return DEFAULT_COLS;
}

export const sortFieldOf = (colId: string) => BY_ID.get(colId)?.sortField;
export const colOfField = (field: SortField, ids: string[]) => ids.find((id) => BY_ID.get(id)?.sortField === field);

export function buildColumns(ids: string[], ctx: Ctx): Column<ScreenerRow>[] {
  return ids.flatMap((id) => {
    const d = BY_ID.get(id);
    return d ? [{ id: d.id, header: d.header ?? d.label, align: d.align, sortable: !!d.sortField, width: d.width || undefined, minWidth: d.minWidth, title: d.title, cell: (r: ScreenerRow) => d.cell(r, ctx) }] : [];
  });
}

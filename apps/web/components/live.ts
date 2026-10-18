// Phase 6 display rules (DESIGN 8.1, 8.3, 8.4). Pure text/class decisions; the server owns expiry and recon.
import { fmt, hm, hms, truncate } from "./fmt";

export type Recon = { at: string | null; status: "ok" | "mismatch" | "late" | null; detail: string | null };
export type Proposal = {
  id: string; conditionId: string; question: string; thesisId: string; side: "YES" | "NO"; orderSide: "BUY" | "SELL"; kind: string;
  shares: number; limitPrice: number; costUsd: number; edgeC: number | null; expectedProfitUsd: number;
  midAtProposal: number; midNow: number | null; createdAt: number; expiresAt: number;
  state: string; reason: string | null; error: string | null; orderId: string | null;
  exitReason?: string | null; fallbackReason?: string | null; decidedVia?: string | null; approval?: string | null; modeAtSend?: string | null;
};
// Phase 7 neg-risk set (DESIGN 9.1, 9.2, 9.8). failedLeg is 0-based.
export type SetLeg = { conditionId: string; question: string; token: "YES" | "NO"; capPrice: number; shares: number; costUsd: number; state: string };
export type SetView = {
  id: string; kind: "set"; setKind: "buy-all" | "sell-all"; eventId: string; state: string; shares: number; costUsd: number;
  lockedC: number | null; expectedProfitUsd: number; createdAt: number; expiresAt: number; decidedVia: string | null; failedLeg: number | null; error: string | null;
  fallbackReason?: string | null; legs: SetLeg[];
  held: { conditionId: string; question: string; token: "YES" | "NO"; shares: number; avgFill: number; bidNow: number | null }[]; suggestedAction: string | null;
};
export type KillResult = { cancelled: number; failed: { orderId: string; error: string }[] };

type Shown = { text: string; cls: string; title?: string };
const pad = (n: number) => String(n).padStart(2, "0");
export const usd2 = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortId = (id: string) => `${id.slice(0, 6)}…`;

/** `12:04 left`; under 2 min `⚠ 1:42 left` in --warn. */
export function countdown(expiresAt: number, now: number): Shown {
  const s = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const t = `${Math.floor(s / 60)}:${pad(s % 60)} left`;
  return s < 120 ? { text: `⚠ ${t}`, cls: "warn", title: `expires ${hms(expiresAt)}` } : { text: t, cls: "", title: `expires ${hms(expiresAt)}` };
}

/** Current mid minus mid at proposal, in cents. `⚠` + --warn at |drift| >= 1.5. */
export function drift(p: Pick<Proposal, "midNow" | "midAtProposal">): Shown {
  if (p.midNow == null) return { text: "—", cls: "muted" };
  const c = (p.midNow - p.midAtProposal) * 100, t = fmt(c, "cents", true);
  return Math.abs(c) >= 1.5 ? { text: `⚠ ${t}`, cls: "warn", title: "Expires at 2.0¢ move" } : { text: t, cls: "" };
}

/** Recent-table state text (8.1). */
export function stateText(p: Pick<Proposal, "state" | "reason" | "error" | "orderId">): Shown {
  switch (p.state) {
    case "sent": return { text: p.orderId ? `sent · ord ${shortId(p.orderId)}` : "sent", cls: "pos", title: p.orderId ?? undefined };
    case "expired": return { text: `expired · ${p.reason ?? "TIMEOUT"}`, cls: p.reason === "PRICE_MOVED" ? "warn" : "muted" };
    case "failed": return { text: `failed · ${truncate(p.error ?? "unknown error", 60)}`, cls: "neg", title: p.error ?? undefined };
    default: return { text: p.state, cls: "muted" };
  }
}

/** Set progress / Recent text (9.2). */
export function setStateText(s: Pick<SetView, "state" | "legs" | "failedLeg" | "error" | "held">): Shown {
  const n = s.legs.length, leg = `leg ${(s.failedLeg ?? 0) + 1}`, err = truncate(s.error ?? "", 60);
  switch (s.state) {
    case "sending": return { text: `sending leg ${Math.min(n, s.legs.filter((l) => l.state === "filled").length + 1)}/${n}…`, cls: "muted" };
    case "unwinding": return { text: `unwinding · ${leg} failed`, cls: "warn" };
    case "filled": return { text: `filled · ${n}/${n} legs`, cls: "pos" };
    case "unwound": return { text: `unwound · ${leg} ${err}`.trim(), cls: "warn", title: s.error ?? undefined };
    case "failed": return { text: `failed · ${leg} ${err}`.trim(), cls: "neg", title: s.error ?? undefined };
    case "flagged": return { text: `flagged · ${s.held.length} leg${s.held.length === 1 ? "" : "s"} held`, cls: "neg" };
    case "acknowledged": return { text: "flagged · acknowledged", cls: "muted" };
    default: return { text: s.state, cls: "muted" };
  }
}

/** Who sent it (9.3): orders carry approval auto|user + modeAtSend, proposals and sets decidedVia. Plain `AUTO` when the mode is unknown. */
export function approvalChip(x: { approval?: string | null; modeAtSend?: string | null; decidedVia?: string | null }): { text: string; color: string } {
  const auto = x.approval === "auto" || x.decidedVia === "auto";
  if (!auto) return { text: "user", color: "var(--muted)" };
  const m = x.modeAtSend === "L4" || x.modeAtSend === "L3" ? x.modeAtSend : null;
  return m ? { text: `AUTO ${m}`, color: `var(--mode-${m.slice(1)})` } : { text: "AUTO", color: "var(--mode-3)" };
}

/** L3 fallback line (9.3). The server sends only the code, so the daily used amount and the category are not shown. */
export function fallbackText(code: string | null | undefined, costUsd: number, l3?: { perTradeUsd: number; dailyNotional: number }): string | null {
  if (!code) return null;
  const t: Record<string, string> = {
    PER_TRADE: `over L3 per-trade${l3 ? ` $${l3.perTradeUsd}` : ""} (this ${usd2(costUsd)})`,
    DAILY_AUTO_NOTIONAL: `daily auto notional${l3 ? ` $${l3.dailyNotional}` : ""} used`,
    CATEGORY_NOT_ALLOWED: "category not in L3 allowlist",
    STRUCTURAL_AUTO_OFF: "sets need structural auto (Settings)",
  };
  return `L3 fallback: ${t[code] ?? code}`;
}

export type Gate = { gate: "L1->L2" | "L2->L3" | "L3->L4"; met: boolean; detail: string; approvedTrades?: number; avgSlippageC?: number | null; liveTrades?: number; realizedEdge30dC?: number | null };
/** L2→L3 / L3→L4 criteria (9.7), each met separately; null for L1→L2 (keeps the server detail). The meter tracks the trade count. */
export function gateParts(g: Gate): { value: number; max: number; parts: { text: string; met: boolean }[] } | null {
  const c = (v: number) => `${fmt(v, "cents", true)}¢`;
  if (g.gate === "L2->L3") {
    const n = g.approvedTrades ?? 0, s = g.avgSlippageC;
    return { value: n, max: 30, parts: [{ text: `${n}/30 approved trades`, met: n >= 30 }, { text: s == null ? "avg slip —" : `avg slip ${c(s)} vs ≤ 1.0¢`, met: s != null && Math.abs(s) <= 1 }] };
  }
  if (g.gate === "L3->L4") {
    const n = g.liveTrades ?? 0, e = g.realizedEdge30dC;
    return { value: n, max: 100, parts: [{ text: `${n}/100 live trades`, met: n >= 100 }, { text: `realized edge 30d ${e == null ? "—" : c(e)}`, met: e != null && e > 0 }] };
  }
  return null;
}

const LATE_MS = 10 * 60_000;
/** One recon line (8.4). Missing/null recon reads as never run. Late is also derived client-side. */
export function reconText(r: Recon | null | undefined, now: number): Shown & { glyph: string; glyphCls: string } {
  if (!r?.at || !r.status) return { glyph: "—", glyphCls: "muted", text: "not run yet", cls: "muted" };
  const at = Date.parse(r.at), when = `${hm(at)} (${Math.max(0, Math.round((now - at) / 60_000))} min ago)`;
  if (r.status === "mismatch") return { glyph: "✗", glyphCls: "neg", text: `MISMATCH · new orders halted · ${hm(at)}${r.detail ? ` · ${truncate(r.detail, 60)}` : ""}`, cls: "neg", title: r.detail ?? undefined };
  if (r.status === "late" || now - at > LATE_MS) return { glyph: "⚠", glyphCls: "warn", text: `late · ${when}`, cls: "warn" };
  return { glyph: "✓", glyphCls: "pos", text: `ok · ${when}`, cls: "muted" };
}

/** Button result text (8.3). */
export function killLabel(r: KillResult | null): string {
  if (!r || (r.cancelled === 0 && r.failed.length === 0)) return "KILLED · L0";
  return `KILLED · L0 · ${r.cancelled} cancelled${r.failed.length ? ` · ${r.failed.length} FAILED` : ""}`;
}

/** ErrorBar text when any cancel failed (8.3); null when all went through. */
export function killError(r: KillResult | null): string | null {
  if (!r?.failed.length) return null;
  const n = r.failed.length, ids = r.failed.map((f) => `ord ${shortId(f.orderId)}: ${f.error}`).join("; ");
  return `Kill: ${n} live order${n === 1 ? "" : "s"} not cancelled (${ids}). Cancel ${n === 1 ? "it" : "them"} on Polymarket or retry.`;
}

/** POST /api/autonomy/kill. Throws on HTTP error. */
export async function postKill(): Promise<KillResult> {
  const r = await fetch("/api/autonomy/kill", { method: "POST" });
  if (!r.ok) throw new Error(`Kill failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return { cancelled: j.cancelled, failed: j.failed ?? [] };
}

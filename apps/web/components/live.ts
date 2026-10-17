// Phase 6 display rules (DESIGN 8.1, 8.3, 8.4). Pure text/class decisions; the server owns expiry and recon.
import { fmt, hm, hms, truncate } from "./fmt";

export type Recon = { at: string | null; status: "ok" | "mismatch" | "late" | null; detail: string | null };
export type Proposal = {
  id: string; conditionId: string; question: string; thesisId: string; side: "YES" | "NO"; orderSide: "BUY" | "SELL"; kind: string;
  shares: number; limitPrice: number; costUsd: number; edgeC: number | null; expectedProfitUsd: number;
  midAtProposal: number; midNow: number | null; createdAt: number; expiresAt: number;
  state: string; reason: string | null; error: string | null; orderId: string | null;
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

/** POST /api/autonomy/kill. Tolerates the pre-phase-6 shape ({cancelledOrders}). Throws on HTTP error. */
export async function postKill(): Promise<KillResult> {
  const r = await fetch("/api/autonomy/kill", { method: "POST" });
  if (!r.ok) throw new Error(`Kill failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return { cancelled: j.cancelled ?? j.cancelledOrders ?? 0, failed: Array.isArray(j.failed) ? j.failed : [] };
}

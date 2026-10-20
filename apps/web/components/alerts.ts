// DESIGN 12.5: alert row model, kind glyphs, ack targets and the list key map. Pure; AlertsList / useAlerts render and fetch.
export type Alert = {
  id: number; conditionId: string | null; kind: string; message: string;
  data: Record<string, unknown> | null; createdAt: number | null; ackedAt: number | null; question: string | null;
};

const ms = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
};

/** GET /api/alerts -> rows + server-side unacked total. Rows without a numeric id are dropped. */
export function parseAlerts(raw: unknown): { rows: Alert[]; unacked: number } | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rows?: unknown }).rows)) return null;
  const r = raw as { rows: Record<string, unknown>[]; unacked?: unknown };
  const rows = r.rows.filter((x) => typeof x?.id === "number").map((x): Alert => ({
    id: x.id as number,
    conditionId: typeof x.conditionId === "string" ? x.conditionId : null,
    kind: String(x.kind ?? ""), message: String(x.message ?? ""),
    data: x.data && typeof x.data === "object" ? (x.data as Record<string, unknown>) : null,
    createdAt: ms(x.createdAt), ackedAt: ms(x.ackedAt),
    question: typeof x.question === "string" ? x.question : typeof (x.data as Record<string, unknown> | null)?.question === "string" ? String((x.data as Record<string, unknown>).question) : null,
  }));
  return { rows, unacked: typeof r.unacked === "number" ? r.unacked : rows.filter((a) => a.ackedAt == null).length };
}

export const KIND: Record<string, { glyph: string; label: string; tone: string }> = {
  mid_move: { glyph: "↕", label: "mid move", tone: "var(--text)" },
  catalyst_passed: { glyph: "⏱", label: "catalyst passed", tone: "var(--warn)" },
  new_candidate: { glyph: "▲", label: "new candidate", tone: "var(--pos)" },
  structural: { glyph: "◆", label: "structural", tone: "var(--badge-s)" },
  run_failed: { glyph: "✕", label: "run failed", tone: "var(--neg)" },
};
export const kindOf = (kind: string) => KIND[kind] ?? { glyph: "·", label: kind.replace(/_/g, " "), tone: "var(--muted)" };

/** Click/Enter destination: `run_failed` -> its pod, everything else -> the market. null = nothing to open. */
export function alertHref(a: Pick<Alert, "kind" | "conditionId" | "data">): string | null {
  if (a.kind === "run_failed") {
    const pod = a.data?.podId;
    return typeof pod === "string" && pod ? `/runs/${encodeURIComponent(pod)}` : null;
  }
  return a.conditionId ? `/markets/${encodeURIComponent(a.conditionId)}` : null;
}

export type ListAct = "open" | "ack" | "ackAll" | null;
/** j/k/Enter/a/A while the list owns the keyboard. Selection clamps; returns the next selection and the action to run. */
export function listKey(key: string, sel: number, n: number): { sel: number; act: ListAct } | null {
  const last = Math.max(0, n - 1);
  switch (key) {
    case "j": return { sel: Math.min(last, sel + 1), act: null };
    case "k": return { sel: Math.max(0, sel - 1), act: null };
    case "Enter": return { sel, act: n ? "open" : null };
    case "a": return { sel, act: n ? "ack" : null };
    case "A": return { sel, act: "ackAll" };
    default: return null;
  }
}

/** Optimistic ack: flip the rows (all open ones when `id` is undefined) and report the new unacked count. */
export function applyAck(rows: Alert[], id: number | undefined, at: number): { rows: Alert[]; unacked: number } {
  const next = rows.map((a) => (a.ackedAt == null && (id === undefined || a.id === id) ? { ...a, ackedAt: at } : a));
  return { rows: next, unacked: next.filter((a) => a.ackedAt == null).length };
}

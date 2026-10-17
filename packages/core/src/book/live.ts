const MIN = 60_000;

/** Proposal lapses after 15 min or a >0.02 price move. */
export function proposalExpiry(p: { createdAt: Date; priceAtProposal: number }, now: Date, currentPrice: number): "TIMEOUT" | "PRICE_MOVED" | null {
  if (now.getTime() - p.createdAt.getTime() >= 15 * MIN) return "TIMEOUT";
  return Math.round(Math.abs(currentPrice - p.priceAtProposal) * 1e8) / 1e8 > 0.02 ? "PRICE_MOVED" : null;
}

/** BUY limit: vwap rounded up to tick; null if worse than pPost - 0.02. */
export function livelimitPrice({ vwap, pPost, tick }: { vwap: number; pPost: number; tick: number }): number | null {
  if (!(tick > 0) || !Number.isFinite(vwap) || !Number.isFinite(pPost)) return null;
  const px = Math.ceil(Math.round(vwap / tick * 1e6) / 1e6) * tick;
  const out = Math.round(px * 1e8) / 1e8;
  return out > Math.round((pPost - 0.02) * 1e8) / 1e8 ? null : out;
}

/** GTD expiry = min(thesis expiry, now+24h); null if under the 3 min SDK minimum (do not send). */
export function gtdExpiry(thesisExpiresAt: Date | null, now: Date): Date | null {
  const cap = new Date(now.getTime() + 24 * 60 * MIN);
  const e = thesisExpiresAt && thesisExpiresAt < cap ? thesisExpiresAt : cap;
  return e.getTime() < now.getTime() + 3 * MIN ? null : e;
}

type Holdings = { usdc: number; positions: Record<string, number> };

/** Compare ledger vs exchange; a missing key counts as 0. */
export function reconcile(ledger: Holdings, exchange: Holdings, tol = { usdc: 0.01, shares: 0.01 }) {
  const mismatches: { key: string; ledger: number; exchange: number }[] = [];
  if (!(Math.abs(ledger.usdc - exchange.usdc) <= tol.usdc)) mismatches.push({ key: "usdc", ledger: ledger.usdc, exchange: exchange.usdc });
  for (const k of new Set([...Object.keys(ledger.positions), ...Object.keys(exchange.positions)])) {
    const l = ledger.positions[k] ?? 0, x = exchange.positions[k] ?? 0;
    if (!(Math.abs(l - x) <= tol.shares)) mismatches.push({ key: k, ledger: l, exchange: x });
  }
  return { ok: mismatches.length === 0, mismatches };
}

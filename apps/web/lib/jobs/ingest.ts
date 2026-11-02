import type { Deps } from "./deps";
import { takeSnapshots, toMarketRow } from "./sweep";

/** Picked search result (Gamma market id) -> `markets` upsert + first book snapshot (research needs one). Undefined = not open / unknown. */
export async function ingestMarket(d: Deps, pmId: string) {
  const m = await d.pm.market(pmId).catch((e) => { if (/\b404\b/.test(String(e?.message))) return undefined; throw e; });
  if (!m?.open || !m.accepting_orders || !m.end_date || Date.parse(m.end_date) <= d.now()) return undefined;
  const row = toMarketRow(m);
  const { conditionId, feeRate: _keep, feeExponent: _keepExp, ...set } = row; // fee stays as stored on update; null = category fallback
  await d.db.markets.upsert(row, set); // ON CONFLICT (condition_id) DO UPDATE
  const snap = await takeSnapshots(d, [conditionId]);
  return { conditionId, hasBook: snap.markets > snap.noBook };
}
